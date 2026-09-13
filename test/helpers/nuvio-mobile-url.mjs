// Model the URL bindings in Nuvio Mobile 0.4.18, JsBindings.kt at
// 13cd02040a6e9b8bc3b5a51c4925fb0603597955. Only absolute parsing is native;
// relative resolution uses string concatenation, and href keeps that string.
// This intentionally preserves the client's bugs instead of fixing the fixture.
export const mobileUrlBindings = `
(function () {
  var AbsoluteURL = URL;
  var Params = URLSearchParams;
  globalThis.URL = function (input, base) {
    var full = input;
    if (base && !/^https?:\\/\\//i.test(input)) {
      var parent = typeof base === 'string' ? base : base.href;
      if (input.charAt(0) === '/') {
        var origin = parent.match(/^(https?:\\/\\/[^\\/]+)/);
        full = origin ? origin[1] + input : input;
      } else {
        full = parent.replace(/\\/[^\\/]*$/, '/') + input;
      }
    }
    var parsed = new AbsoluteURL(full);
    this.href = full;
    this.protocol = parsed.protocol;
    this.host = parsed.host;
    this.hostname = parsed.hostname;
    this.port = parsed.port;
    this.pathname = parsed.pathname;
    this.search = parsed.search;
    this.hash = parsed.hash;
    this.origin = parsed.protocol + '//' + parsed.host;
    this.searchParams = new Params(parsed.search || '');
  };
  URL.prototype.toString = function () { return this.href; };
})();
`;
