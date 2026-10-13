# Local frame instructions

For work on this owner's connected Pastigio frame, first read
`diagnostics/frame156-session/FRAME.md`. It contains the private Wi-Fi ADB
address, connection commands, installed setup, and backup preferences. The
`diagnostics/` directory is intentionally ignored by Git; do not copy its
addresses, identifiers, signing keys, or dumps into tracked documentation.

The owner likes the installed dashboard as it is. Preserve its current behavior
unless the owner requests a change. Do not repeat firmware captures for routine
reconnection, inspection, or use of the installed dashboard. For firmware or
partition changes, follow the README's identity and backup requirements.

Always select the intended ADB transport explicitly: USB and Wi-Fi can expose
the same frame as two entries. Use the address in the private notes for network
commands and `adb -d` for the single USB device. Verify the model before changes.
