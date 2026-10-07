// The activity log's pages, as the page lays them out. Kept apart from
// ActivityLog.jsx so tests/activity-pages.test.mjs can check them without a
// browser.

// Pages the server sent, as days: a very busy day can arrive in two parts,
// and is still one day, under one heading.
export function daysOf(pages) {
  const days = [];
  for (const d of pages.flatMap((page) => page.days)) {
    const last = days.at(-1);
    if (last && last.day === d.day)
      last.entries = [...last.entries, ...d.entries];
    else days.push({ ...d, entries: [...d.entries] });
  }
  return days;
}

// The first page read again (the server was asked for everything back to
// where the first page stopped) takes that page's place, and the days loaded
// below it follow on as they were. Past midnight, or on another time zone,
// the days below would have yesterday's headings or the old clock's times,
// and a first page that stops somewhere else would leave a gap or say a line
// twice: then it starts again from the fresh page.
export function laid(pages, fresh) {
  const [first, ...rest] = pages || [];
  if (
    !first ||
    fresh.today !== first.today ||
    fresh.timezone !== first.timezone ||
    (fresh.next?.before || null) !== (first.next?.before || null)
  )
    return [fresh];
  return [fresh, ...rest];
}
