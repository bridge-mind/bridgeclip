async function captionPresetAction(page, preset, action) {
  await page.getByRole('button', { name: `Actions for ${preset}`, exact: true }).click()
  await page.getByRole('menu', { name: `Actions for ${preset}`, exact: true }).getByRole('menuitem', { name: action, exact: true }).click()
}

module.exports = { captionPresetAction }
