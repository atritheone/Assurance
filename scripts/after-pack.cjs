const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const { rcedit } = await import("rcedit");
  const appInfo = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, "build", "icon.ico");

  await rcedit(exePath, {
    icon: iconPath,
    "file-version": "0.31.0.0",
    "product-version": "0.31.0.0",
    "version-string": {
      CompanyName: "slayer",
      FileDescription: appInfo.productName,
      FileVersion: "0.31",
      InternalName: appInfo.productFilename,
      LegalCopyright: "slayer",
      LegalTrademarks: "slayer",
      OriginalFilename: `${appInfo.productFilename}.exe`,
      ProductName: appInfo.productName,
      ProductVersion: "0.31"
    }
  });
};
