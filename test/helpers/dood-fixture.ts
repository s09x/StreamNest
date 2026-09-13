// Synthetic examples of the public player contract; no live media URLs or tokens.
export const doodToken = 'syntheticfiletoken1234';
export const doodPass = `/pass_md5/123456-1-1-1700000000-fixture/${doodToken}`;
export const doodEmbed = 'https://vide0.net/e/abcdefgh1234';
export const doodFinal = 'https://playmogo.com/e/abcdefgh1234';
export const doodPrefix = 'https://media.example.invalid/files/synthetic/';

export function doodScript(token = doodToken, pass = doodPass): string {
  return `$.get('${pass}', function(data) {
    if (data === 'RELOAD') { location.reload(); }
    dsplayer.src({ type: 'video/mp4', src: data + makePlay() });
  });
  function makePlay() {
    for (var a = '', t = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', n = t.length, o = 0; 10 > o; o++) a += t.charAt(Math.floor(Math.random() * n));
    return a + '?token=${token}&expiry=' + Date.now();
  }`;
}

export function doodPage(script = doodScript(), depth = 0): string {
  return `<html><head><title>Synthetic upload.2160p.HEVC - DoodStream</title></head><body>
    ${'<div>'.repeat(depth)}<script>${script}</script>${'</div>'.repeat(depth)}
    <script>throw new Error('Player scripts must not execute');</script>
    <script>turnstile.render(document.body, {size:'invisible'});</script>
    <video><track src="data:text/vtt;base64,V0VCVlRUCgo=" srclang="es"></video>
    </body></html>`;
}
