# Assurance Android Wrapper

This folder is an isolated Capacitor wrapper for Android Studio. It consumes the existing Assurance renderer build from `../../dist/renderer` and copies it into this wrapper's `www` directory.

The desktop Electron builds and standalone HTML build stay owned by the repository root. Do not move game source files into this wrapper.

## First Setup

From the repository root:

```powershell
npm test
npm run build
```

From this folder:

```powershell
npm install
npm run copy:web
npx cap add android
npm run sync
npm run open
```

Android Studio should open the nested `android` project.

The generated Android activity is portrait-only. Android-specific layout CSS and navigation behavior are injected from `android-assets` into the copied `www` build during `npm run sync`.

## Updating Web Assets

After changing Assurance source files:

```powershell
cd ..\..
npm run build
cd platforms\android-wrapper
npm run sync
```

Then rebuild or run from Android Studio.

## Debug APK

From this folder:

```powershell
npm run apk:debug
```

The debug APK is written under:

```text
android/app/build/outputs/apk/debug/
```

If command-line builds fail because Java is not on `PATH`, Android Studio's bundled JDK can be used for the current PowerShell session:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
npm run apk:debug
```

If Gradle reports that the SDK location is missing, open `android` in Android Studio and install/select an Android SDK. Android Studio will create `android/local.properties` with the local `sdk.dir` path. That file is intentionally ignored because it is machine-specific.
