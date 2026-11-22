# Monochrome Connect on a Raspberry Pi (or any Linux box)

Turns a Pi with a Bluetooth (or wired) speaker into a device you can pick in Monochrome.

## 1. Get the receiver

```bash
sudo apt install mpv python3        # mpv is best; ffplay also works
curl -fsSL https://YOUR-MONOCHROME-ADDRESS/__off/connect/agent.py -o monochrome-connect.py
```

## 2. Pair it

```bash
python3 monochrome-connect.py --server https://YOUR-MONOCHROME-ADDRESS --name "Living room"
```

It prints a code like `ABCD-EFGH` (valid 10 minutes). In Monochrome click the speaker button, choose **Add a device** and type it. The receiver prints which account paired it; if that is not you, remove the device in Monochrome and run `--unpair`.

After that just run `python3 monochrome-connect.py`. It keeps its token in `~/.config/monochrome-connect/device.json`.

## 3. Your commands

`~/.config/monochrome-connect/commands.ini` (created on first run, re-read for every song):

```ini
[commands]
play   = mpv --no-video --no-terminal --really-quiet --start="$MC_POS" --volume="$MC_VOL" "$MC_URL"
volume = wpctl set-volume @DEFAULT_AUDIO_SINK@ "$MC_VOL%"
before = bluetoothctl connect AA:BB:CC:DD:EE:FF
after  = bluetoothctl disconnect AA:BB:CC:DD:EE:FF
```

- `play` plays one song and exits when it ends (the receiver restarts it for pause and seek). Empty = mpv, else ffplay.
- `before` runs before the first song after about 5 quiet minutes, `after` when playback stops or goes quiet: wake or release the Bluetooth speaker.
- The server never sends a command. It only says which song and which second; those reach your commands as `MC_URL`, `MC_POS`, `MC_DUR`, `MC_VOL`, `MC_TITLE`. Always keep them in double quotes.

Bluetooth: pair the speaker once with `bluetoothctl` (`scan on`, `pair`, `trust`, `connect`), and make sure it is the default sound output.

## 4. Run at boot

```bash
python3 monochrome-connect.py --print-systemd
```

prints a systemd **user** service and the three commands to enable it (a user service because the sound and Bluetooth belong to your login; `loginctl enable-linger` starts it at boot).

## Tests

```bash
python3 -m unittest discover -s connect -v
```
