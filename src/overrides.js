// Gives each planned shot its own identity in Flagsmith, with an override for one flag.
//
// When the app loads as flagshots-hero_layout-split, Flagsmith answers with hero_layout set to
// "split" and every other flag at its normal value. The environment's own settings aren't
// touched, so real visitors see no change.

// Two flags count as showing the same thing when both are off, or both are on with one value.
function same(a, b) {
  if (!a || !b || a.enabled !== b.enabled) return false;
  return !a.enabled || String(a.value) === String(b.value);
}

function describe(flag) {
  if (!flag) return 'missing';
  return flag.enabled ? `on with ${JSON.stringify(flag.value)}` : 'off';
}

export async function applyOverrides(admin, environmentKey, rows) {
  const visitor = await admin.flagsForVisitor(environmentKey);
  let pinned = 0;

  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.identity) continue;
      const identity = await admin.identity(environmentKey, cell.identity);
      await admin.setIdentityOverride(environmentKey, identity.id, row.featureId, {
        enabled: cell.enabled,
        value: cell.value,
      });

      // Flagsmith puts every identity into a bucket for a flag that's in an experiment or has a
      // percentage split, so a shot identity could land on a treatment value of some other flag.
      // Those flags get an override too, holding them at what the default shot shows. Then the
      // only difference between this shot and the default is the flag in this row.
      const flags = await admin.flagsForIdentity(environmentKey, cell.identity);
      for (const [name, flag] of flags) {
        const want = visitor.get(name);
        if (name === row.flag || !want || same(flag, want)) continue;
        await admin.setIdentityOverride(environmentKey, identity.id, flag.id, { enabled: want.enabled, value: want.value });
        pinned++;
      }
    }
  }
  if (pinned) {
    console.log(`Held ${pinned} split or experiment flag values at the default so each shot changes one flag`);
  }
}

// Asks Flagsmith for each identity's flags, as the app will, and checks that the row's flag has
// the state under test and every other flag matches the default shot. A screenshot of the wrong
// state would be worse than no screenshot.
export async function checkOverrides(admin, environmentKey, rows) {
  const visitor = await admin.flagsForVisitor(environmentKey);
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.identity) continue;
      const flags = await admin.flagsForIdentity(environmentKey, cell.identity);
      const want = { enabled: cell.enabled, value: cell.value };
      if (!same(flags.get(row.flag), want)) {
        throw new Error(
          `Flagsmith gave ${cell.identity} ${row.flag} ${describe(flags.get(row.flag))}, expected ${describe(want)}`,
        );
      }
      for (const [name, flag] of flags) {
        if (name !== row.flag && !same(flag, visitor.get(name))) {
          throw new Error(
            `Flagsmith gave ${cell.identity} ${name} ${describe(flag)}, but the default shot has it ` +
              `${describe(visitor.get(name))}. Only ${row.flag} should change in this shot.`,
          );
        }
      }
    }
  }
}
