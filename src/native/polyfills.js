// Nuvio normally provides atob. Keep parser initialization independent of Node's Buffer.
(function (root) {
  if (typeof root.atob === 'function') return;
  root.atob = function (value) {
    var input = String(value).replace(/[\t\n\f\r ]/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1 || (input.indexOf('=') !== -1 && input.length % 4 !== 0)) {
      throw new Error('Invalid base64 input');
    }
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var result = '', bits = 0, count = 0;
    input = input.replace(/=+$/, '');
    for (var i = 0; i < input.length; i++) {
      bits = (bits << 6) | alphabet.indexOf(input.charAt(i));
      count += 6;
      if (count >= 8) {
        count -= 8;
        result += String.fromCharCode((bits >> count) & 255);
        bits &= (1 << count) - 1;
      }
    }
    return result;
  };
})(globalThis);
