# Opens (or closes) Windows voice typing by pressing Win+H.
#
# Voice typing is Windows' own dictation panel: the most accurate engine on
# the machine, with punctuation, and it types straight into whatever text box
# has focus. XodeCode focuses the prompt box first, then runs this.

Add-Type -Namespace XodeCode -Name Keys -MemberDefinition @'
[DllImport("user32.dll")]
public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@

$KEYUP = 2
[XodeCode.Keys]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)       # Win down
[XodeCode.Keys]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)       # H down
[XodeCode.Keys]::keybd_event(0x48, 0, $KEYUP, [UIntPtr]::Zero)  # H up
[XodeCode.Keys]::keybd_event(0x5B, 0, $KEYUP, [UIntPtr]::Zero)  # Win up
