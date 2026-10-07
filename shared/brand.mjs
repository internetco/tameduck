// The handful of brand values that have to exist outside a stylesheet.
//
// Email cannot use our CSS: there is no cascade to rely on, half the clients
// strip <style>, and every colour has to be written into the tag that uses it.
// So the few we need in an email live here as plain strings, in shared/ where
// the server can read them too. These are the same values as the tokens in
// src/themes.css for the default theme; if those change, change these.
export const BRAND = {
  ink: "#1A1533",
  muted: "#56506E",
  yellow: "#ffce32",
  violet: "#5c35df",
  line: "#E6DFD0",
  paper: "#FBF8F1",
  // No web font in an email. This is the stack that lands closest to the
  // product's own on the platforms people read mail on.
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
};
