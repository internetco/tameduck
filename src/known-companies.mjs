// The companies this person had on their last visit, kept in this browser, so
// the page that opens TameDuck can say which company it is opening before
// anything has loaded, and offer another one when it will not open. It keeps
// ids and names and nothing else, the last one opened first. Signing out takes
// them off the browser, and so does every page of the way in
// (public/auth.js, by this key), since a session that ran out never said so.
//
// Like the recent places next door, this is a convenience: a store that is
// missing or blocked only means the page says "Opening TameDuck…".
const KEY = "tameduck:companies";
const local = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

export function knownCompanies(storage = local()) {
  try {
    const kept = JSON.parse(storage?.getItem(KEY) || "null");
    return {
      user: typeof kept?.user === "string" ? kept.user : null,
      companies: Array.isArray(kept?.companies)
        ? kept.companies.filter(
            (c) => c && typeof c.id === "string" && typeof c.name === "string",
          )
        : [],
    };
  } catch {
    return { user: null, companies: [] };
  }
}

// The one that is open first, then the rest in the order they were last open.
export function orderCompanies(known, state) {
  const was = known.user === state.user.id ? known.companies : [];
  const rank = (c) => {
    const at = was.findIndex((k) => k.id === c.id);
    return at < 0 ? was.length : at;
  };
  return [
    { id: state.company.id, name: state.company.name },
    ...state.companies
      .filter((c) => c.id !== state.company.id)
      .sort((a, b) => rank(a) - rank(b))
      .map((c) => ({ id: c.id, name: c.name })),
  ];
}

export function noteCompanies(state, storage = local()) {
  if (!state?.user?.id || !state.company?.id) return;
  const next = JSON.stringify({
    user: state.user.id,
    companies: orderCompanies(knownCompanies(storage), state),
  });
  // The workspace is loaded again on every change a duck reports, several
  // times a second while one writes. Only a change is worth writing.
  try {
    if (storage?.getItem(KEY) !== next) storage?.setItem(KEY, next);
  } catch {}
}

export function forgetCompanies(storage = local()) {
  try {
    storage?.removeItem(KEY);
  } catch {}
}

// The company a page is about: the one in the address, or with none there,
// the one open last time. Only a name this browser has seen is used.
export function companyToOpen(known, companyId) {
  if (companyId) return known.companies.find((c) => c.id === companyId) || null;
  return known.companies[0] || null;
}

// Another company to offer when that one will not open.
export function otherCompany(known, companyId) {
  const skip = companyId || known.companies[0]?.id;
  return known.companies.find((c) => c.id !== skip) || null;
}
