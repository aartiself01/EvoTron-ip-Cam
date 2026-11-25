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
    npm run dist        # build the installer: dist/EvoTron Setup 1.2.0.exe

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

## ONVIF, PTZ and snapshots
- Add camera > **Search cameras on network (ONVIF)** lists cameras that answer on the local network. Pick one, enter the username and password, press **Auto detect streams**: the main and sub stream addresses, H.265 conversion and PTZ support are filled in automatically. ONVIF must be turned on in the camera, and the ONVIF port is usually 80 (some cameras use 8080 or 2020). The video itself still travels over RTSP.
- Click a camera to open it large. Below the picture you get **Take snapshot** (saves a JPG with channel, name and time) and, for PTZ cameras, arrow and zoom buttons (hold to move, release to stop).
- On the phone, the snapshot opens the share sheet so you can save it to the gallery or send it.
- If a camera is added by hand (without Auto detect), PTZ is not available for it. Edit the camera and run Auto detect once.

## Forgot the login password
1. **On the PC (EvoTron app):** on the login screen press **Forgot password? > Reset on this PC**. The password becomes `admin`. (The same is in the menu: press Alt > EvoTron > Reset login password.)
2. **By email (also from the phone):** first save a recovery email in Settings > Password recovery by email. For Gmail: turn on 2-step verification, create an *App password* (myaccount.google.com/apppasswords) and paste it as the app password, server `smtp.gmail.com`, port `587`. Press Send test email to check. Later, on the login screen press **Forgot password? > Email me a code**, enter the 6-digit code and a new password. The code is valid for 10 minutes and 3 codes can be asked per 15 minutes.
3. **If the app cannot be opened:** close it, open `%APPDATA%` in File Explorer, find the folder `evotron-data`, open `config.json` in Notepad, change `"password": "..."` to `"password": ""`, save, start the app again. The password is then `admin`.
The email password is stored in config.json on the PC, like the camera passwords. SMS recovery is not included, because it needs a paid SMS service.

## Built-in sending account for password recovery emails (optional)
Instead of every user typing a sender email and app password, you can bake ONE sending account into the Windows installer:
1. Use a separate Gmail (or other mail) account only for this, with an App password.
2. In your GitHub repository: Settings > Secrets and variables > Actions > New repository secret. Add `SMTP_USER` (the sender email) and `SMTP_PASS` (the app password). Optional: `SMTP_HOST` (default smtp.gmail.com) and `SMTP_PORT` (default 587).
3. Make the repository **Private** (Settings > General > Danger Zone), because the finished installer contains this account.
4. Run the build again. In Settings the user then only sees the field "Recovery email".
Anyone who has the installer can extract the account, so use a dedicated mailbox and revoke the app password in Google if the installer leaks. For standalone server use, the environment variables EVOTRON_SMTP_USER, EVOTRON_SMTP_PASS (and _HOST, _PORT) do the same.

## Sound (camera microphone)
- Live sound: open one camera (click it) and press **Sound: off** to turn the sound on. The big picture uses the camera main stream, which carries the sound. The small grid tiles use the sub stream and stay silent. On phones the first tap on the button is needed to allow sound.
- Recordings keep the sound and play with sound in Playback.
- Each camera has a checkbox **Camera microphone (live sound and recordings)** in Add/Edit camera. Turn it off to stop sound in live view and recordings.
- The microphone must also be switched on in the camera itself (in its web page: Audio / Encode settings), otherwise there is no sound to play. Camera audio (G.711) is converted to AAC automatically.
- Audio recording can need consent under local law. Turn the checkbox off where that applies.

## Remembered camera login
When you add a camera, EvoTron remembers the last camera Username and Password on this device and fills them in for the next camera, so cameras with the same password need no typing. Change the password in the box if a camera has a different one. Settings > "Forget the remembered camera password" removes it. The password is kept in the app storage of this device (the same place as the login session).

## Version and build number
The version is set in `package.json` ("version": "1.2.0" shows as v1.2). The GitHub build adds a build number that grows with every run, so the footer shows for example "EvoTron v1.2 (build 15)". If the footer shows a different number than the newest GitHub run, the old installer is still running.

## How it works
- Live view: the grid uses the camera sub stream (light), single view uses the main stream. Streams start only when someone is watching and stop after 30 seconds of no viewers.
- Recording: cameras with "Record continuously" are saved as 10 minute files in the data folder, kept for 7 days (`retentionDays` in `config.json`).
- Data folder (desktop app): `%APPDATA%\evotron-vms\evotron-data` (config.json, recordings).

## Security notes
- This is built for a local network. Camera passwords are stored in config.json on the PC.
- Do not expose port 8080 to the internet without HTTPS or a VPN.
