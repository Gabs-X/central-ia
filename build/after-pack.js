// Aplica ícone e metadados ao .exe depois do empacotamento.
// (O electron-builder faria isso sozinho, mas o pacote winCodeSign dele
// exige permissão de link simbólico no Windows; aqui usamos o rcedit direto.)
const path = require('path');
const rceditModule = require('rcedit');
const rcedit = rceditModule.rcedit || rceditModule;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { productFilename } = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${productFilename}.exe`);
  const version = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: 'Central IA',
      FileDescription: 'Central IA',
      CompanyName: 'Gabs-X',
      LegalCopyright: 'Gabs-X',
    },
  });
};
