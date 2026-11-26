// Gives each planned shot its own identity in Flagsmith, with an override for one flag.
//
// When the app loads as flagshots-hero_layout-split, Flagsmith answers with hero_layout set to
// "split" and every other flag at its normal value. The environment's own settings aren't
// touched, so real visitors see no change.

export async function applyOverrides(admin, environmentKey, rows) {
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.identity) continue;
      const identity = await admin.identity(environmentKey, cell.identity);
      await admin.setIdentityOverride(environmentKey, identity.id, row.featureId, {
        enabled: cell.enabled,
        value: cell.value,
      });
    }
  }
}

// Asks Flagsmith for each identity's flags, as the app will, and checks the override is what
// comes back. A screenshot of the wrong state would be worse than no screenshot.
export async function checkOverrides(admin, environmentKey, rows) {
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.identity) continue;
      const flag = (await admin.flagsForIdentity(environmentKey, cell.identity)).get(row.flag);
      const valueMatches = !cell.enabled || String(flag?.value) === String(cell.value);
      if (!flag || flag.enabled !== cell.enabled || !valueMatches) {
        throw new Error(
          `Flagsmith gave ${cell.identity} ${row.flag} = ${JSON.stringify(flag)}, expected ` +
            `${cell.enabled ? 'on' : 'off'}${cell.enabled ? ` with ${JSON.stringify(cell.value)}` : ''}`,
        );
      }
    }
  }
}
