// Works out which screenshots to take, from what Flagsmith says about each feature.
//
// One screenshot is the page as an ordinary visitor sees it today (the "default" shot).
// Then, for each flag, one screenshot per state the flag can be in that isn't already the
// default. Only that one flag changes in each shot; the other flags keep their real values.
// The demo's four flags make six shots plus the default this way. Every combination
// of them would be eighteen.
//
// This file only does arithmetic on data: no network, no browser. test/plan.test.js covers it.

// The value of a multivariate option. Flagsmith stores strings, integers and booleans
// in separate fields.
function optionValue(option) {
  if (option.type === 'int') return option.integer_value;
  if (option.type === 'bool') return option.boolean_value;
  return option.string_value;
}

// Turns a value into something safe for an identity name: "Try it free" -> "try-it-free".
export function slug(value) {
  const s = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'empty';
}

// features: GET /projects/{id}/features/
// states:   the environment's feature states (environmentFeatureStates in flagsmith-admin.js)
// only:     optional list of flag names to include, for apps with many flags
// Returns one row per flag. Each row has a cell per state, with the default first.
// A cell with identity null is the default shot; the others need an identity override.
export function planShots(features, states, { only } = {}) {
  const stateByFeature = new Map(states.map((s) => [s.feature, s]));
  const usedIdentities = new Set();

  // Two values can slug to the same name ("Get started" and "get-started"),
  // so a number goes on the end of the second one.
  function identityFor(flag, label) {
    const base = `flagshots-${flag}-${slug(label)}`;
    let name = base;
    for (let n = 2; usedIdentities.has(name); n++) name = `${base}-${n}`;
    usedIdentities.add(name);
    return name;
  }

  const rows = [];
  const sorted = [...features].sort((a, b) => a.name.localeCompare(b.name));
  for (const feature of sorted) {
    if (only && !only.includes(feature.name)) continue;
    const current = stateByFeature.get(feature.id);
    if (!current) continue;

    const cells = [];
    if (feature.type === 'MULTIVARIATE') {
      // The control value plus each option. If the flag is switched off in the environment,
      // the default cell shows it off and every value, the control value included, gets a shot.
      const values = [current.feature_state_value, ...feature.multivariate_options.map(optionValue)];
      if (current.enabled) {
        cells.push({ label: String(values[0]), enabled: true, value: values[0], isDefault: true, identity: null });
        values.shift();
      } else {
        cells.push({ label: 'Off', enabled: false, value: current.feature_state_value, isDefault: true, identity: null });
      }
      for (const value of values) {
        const label = String(value);
        cells.push({ label, enabled: true, value, isDefault: false, identity: identityFor(feature.name, label) });
      }
    } else {
      // An on/off flag: the state it's in now, then the opposite.
      const on = Boolean(current.enabled);
      const value = current.feature_state_value;
      cells.push({ label: on ? 'On' : 'Off', enabled: on, value, isDefault: true, identity: null });
      const other = on ? 'Off' : 'On';
      cells.push({ label: other, enabled: !on, value, isDefault: false, identity: identityFor(feature.name, other) });
    }

    rows.push({ flag: feature.name, featureId: feature.id, description: feature.description ?? '', cells });
  }
  return rows;
}
