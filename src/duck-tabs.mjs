// The tabs of the duck dialog: which ones there are, in what order, and what
// the mark on each one says.
//
// Kept out of the component so it can be tested. The marks are a promise: a
// tick on a tab that is blank, or "Empty" on one that has been written, is
// worse than the bare words these tabs used to be.
const written = (text) => !!String(text || "").trim();

const mark = (filled, yes = "Filled in", no = "Empty") => ({
  mark: filled ? "filled" : "empty",
  label: filled ? yes : no,
});

export function duckTabs({
  form,
  duck,
  edit,
  skillsOn = 0,
  contacts,
  ducks = [],
  webhook,
}) {
  const job = written(form.identity);
  // Whoever is looking can change this duck. Nobody can while it is off the
  // team: there is nothing to save with until it is put back.
  const open = edit && !duck?.removed;
  const tabs = [
    {
      id: "profile",
      name: "Profile",
      about: "Name and face",
      ...mark(written(form.name) && written(form.role)),
    },
    {
      id: "identity.md",
      name: "Its job",
      about: "What it does",
      // The one tab a duck is no use without, so a blank one is said in words
      // and in the colour of things that need you - but only to somebody who
      // can do something about it.
      ...(job || !open ? mark(job) : { mark: "needed", label: "Empty" }),
    },
    {
      id: "soul.md",
      name: "Character",
      about: "How it behaves",
      ...mark(written(form.soul)),
    },
    {
      id: "notes",
      name: "Notes",
      about: "What it remembers",
      ...mark(written(form.notes)),
    },
  ];
  // These two belong to a duck that exists: a new one has nowhere to keep them.
  if (duck)
    tabs.push({
      id: "skills",
      name: "Skills",
      about: "Playbooks it uses",
      ...mark(skillsOn > 0, skillsOn + " turned on", "None turned on"),
    });
  // A duck that is off the team asks nobody, and the server says so instead of
  // listing its contacts, so there the tab was only ever an error.
  if (duck && open) {
    // Everyone is the default, so this is ticked from the start. It is only
    // hollow when the duck really can ask nobody. A duck the settings do not
    // list gets no mark rather than a guess.
    const chosen = (contacts?.allowed_duck_ids || []).filter((id) =>
      ducks.some((d) => d.id === id && !d.removed),
    ).length;
    tabs.push({
      id: "contacts",
      name: "Contacts",
      about: "Ducks it can ask",
      ...(!contacts
        ? { mark: null, label: "" }
        : contacts.mode === "all"
          ? mark(true, "Everyone")
          : mark(
              contacts.mode === "selected" && chosen > 0,
              chosen + " chosen",
              "Nobody",
            )),
    });
  }
  // Tasks from other apps: only for somebody who may change ducks, since only
  // they can turn it on, and only for a duck on the team.
  if (duck && open)
    tabs.push({
      id: "webhook",
      name: "Webhook",
      about: "Tasks from other apps",
      ...mark(!!webhook, "On", "Off"),
    });
  return tabs;
}

// The short row of faces on the Profile tab: the first five, with the last
// place given up to a face picked from the full set, so that whatever is
// chosen can always be seen chosen.
export function faceRow(faces, kept, size = 5) {
  const row = faces.slice(0, size);
  const extra = faces.find((f) => f.id === kept);
  if (extra && !row.includes(extra)) row[size - 1] = extra;
  return row;
}
