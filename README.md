# EvoTron 32-Channel IP Camera Monitoring

One project, three parts:

- `server.js`  : connects to the cameras (RTSP, via FFmpeg), serves live video, records, handles login.
- Desktop app  : `main.js` (Electron). Runs the server inside the app and opens the EvoTron window. Builds into a Windows installer (.exe).
- Mobile app   : `mobile/` (Capacitor). Same EvoTron screens, packaged as an Android (and iOS) app that connects to the server on your PC.

Default login password: `admin` (the app asks you to change it).

## Getting the .exe and .apk without installing anything (GitHub)
1. Create a free GitHub account and a new repository, then upload all files of this project (keep the `.github` folder).
2. Open the repository > Actions > "Build EvoTron" > Run workflow.
3. After about 10 minutes, open the finished run and download `EvoTron-Windows-exe` (installer) and `EvoTron-Android-apk` from the Artifacts section.
The APK is a debug build: it installs on any Android phone (allow "install unknown apps").

## 1. Windows desktop app
Needs Node.js 20 or newer (https://nodejs.org).

    npm install
    npm start           # run the app
    npm run dist        # build the installer: dist/EvoTron Setup 1.0.0.exe

Optional: put a square `build/icon.ico` (256x256) in the project for a custom app icon.

On first start Windows Firewall may ask for permission. Allow it on Private networks, otherwise the phone cannot connect.

## 2. Mobile app
Android needs Android Studio. iOS needs a Mac with Xcode.

    cd mobile
    npm install
    npx cap add android      # (and/or: npx cap add ios)
    npm run sync
    npx cap open android     # build the APK from Android Studio

When the app opens, enter the server address, for example `192.168.1.50:8080`
(the IP address of the PC running EvoTron, on the same Wi-Fi), and the password.
For iOS, allow local network / HTTP access in Info.plist (NSAppTransportSecurity > NSAllowsLocalNetworking).

## Adding cameras
Open Cameras > Add camera. Enter channel, name, IP, port (554), username and password.
The default stream paths are for CP Plus / Dahua style cameras:

    main:  /cam/realmonitor?channel=1&subtype=0
    sub:   /cam/realmonitor?channel=1&subtype=1

For Hikvision use `/Streaming/Channels/101` (main) and `/Streaming/Channels/102` (sub),
or paste the full RTSP URL under Advanced. H.265 cameras: tick "Convert to H.264".

## How it works
- Live view: the grid uses the camera sub stream (light), single view uses the main stream. Streams start only when someone is watching and stop after 30 seconds of no viewers.
- Recording: cameras with "Record continuously" are saved as 10 minute files in the data folder, kept for 7 days (`retentionDays` in `config.json`).
- Data folder (desktop app): `%APPDATA%\evotron-vms\evotron-data` (config.json, recordings).

## Security notes
- This is built for a local network. Camera passwords are stored in config.json on the PC.
- Do not expose port 8080 to the internet without HTTPS or a VPN.
