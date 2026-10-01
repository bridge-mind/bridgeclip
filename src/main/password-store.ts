/**
 * Chromium encrypts saved secrets with the desktop keyring only on desktops it
 * recognises, such as GNOME, KDE, Cinnamon and Xfce. On others (sway, i3,
 * Hyprland, LXQt) it picks the plaintext `basic_text` store, which BridgeClip
 * refuses, even when a Secret Service keyring is running. Ask for libsecret
 * there instead; without a running keyring, encryption simply stays unavailable.
 *
 * KDE keeps KWallet, which existing keys may already be encrypted with, and an
 * explicit --password-store always wins. Must run before the app is ready.
 */
export function linuxPasswordStore(env: NodeJS.ProcessEnv, hasPasswordStoreSwitch: boolean): 'gnome-libsecret' | null {
  if (hasPasswordStoreSwitch) return null
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').split(':').map((desktop) => desktop.trim().toLowerCase())
  const kde = desktops.includes('kde') || /kde|plasma/i.test(env.DESKTOP_SESSION ?? '') || Boolean(env.KDE_FULL_SESSION)
  return kde ? null : 'gnome-libsecret'
}
