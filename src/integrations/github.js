// GitHub pelo `gh` já logado: PRs esperando seu review e PRs suas abertas.
const { execFile } = require('child_process');

function gh(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

async function tokenFor(account) {
  return (await gh(['auth', 'token', '--user', account])).trim();
}

const FIELDS = 'number,title,repository,url,updatedAt,author,isDraft';

async function search(account, filter) {
  const token = await tokenFor(account);
  const out = await gh(['search', 'prs', filter, '--state=open', '--json', FIELDS, '--limit', '30'], { GH_TOKEN: token });
  return JSON.parse(out || '[]').map((p) => ({
    account,
    number: p.number,
    title: p.title,
    repo: p.repository?.nameWithOwner || p.repository?.name,
    url: p.url,
    updatedAt: p.updatedAt,
    author: p.author?.login,
    draft: p.isDraft,
  }));
}

class GitHub {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
    this.cache = null;
    this.fetchedAt = 0;
  }

  async prs(force = false) {
    const cfg = this.getConfig().integrations.github;
    if (!cfg.enabled) return { review: [], mine: [], errors: [], disabled: true };
    if (!force && this.cache && Date.now() - this.fetchedAt < 10 * 60_000) return this.cache;
    const review = [];
    const mine = [];
    const errors = [];
    for (const acc of cfg.accounts) {
      try {
        review.push(...(await search(acc, '--review-requested=@me')));
        mine.push(...(await search(acc, '--author=@me')));
      } catch (err) {
        errors.push(`${acc}: ${err.message}`);
      }
    }
    this.cache = { review, mine, errors, fetchedAt: Date.now() };
    this.fetchedAt = Date.now();
    return this.cache;
  }
}

module.exports = { GitHub };
