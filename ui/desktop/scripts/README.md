# Goosey

Put `goosey` in your $PATH if you want to launch via:

```
goosey .
```

This will open the OpenDuck GUI from any path you specify

# Unregister Deeplink Protocols (macos only)

`unregister-deeplink-protocols.js` is a script to unregister the deeplink
protocols used by OpenDuck (`openduck://` and legacy `goose://`).
This is handy when you want to test deeplinks with the development version of OpenDuck.

# Usage

To unregister the deeplink protocols, run the following command in your terminal:
Then launch OpenDuck again and your deeplinks should work from the latest launched application as it is registered on startup.

```bash
node scripts/unregister-deeplink-protocols.js
```

