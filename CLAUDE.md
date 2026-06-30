# A.P.P.A. — Claude Code Context

## Estructura del proyecto
- **Una sola SPA**: todo el código está en `app.js` (~4400+ líneas). No hay build system, bundler, ni dependencias npm. Se sirve estático.
- Archivos estáticos: `app.js`, íconos PNG, `manifest.json`, librerías JS (`lamejs.js`, `soundtouch.js`, `ffmpeg*.js`).

## Módulo de Acordes (línea ~3507)

### CT — Chord Types array (línea ~3527)
Define los 19 tipos de acordes que aparecen en la UI (detección + constructor).
```js
{ es: 'nombre español', en: 'keyEn', iv: [intervalos en semitonos] }
```
Si se agrega un tipo nuevo de acorde, **debe agregarse aquí Y en el DB correspondiente**.

### GDB — Guitar chord Database (línea ~3611)
Guitarra: 6 cuerdas `[E A D G B e]` (str0=low E, str5=high e). Fret -1 = cuerda muda.

### UDB — Ukulele chord Database (línea ~4043)
Ukulele: 4 cuerdas `[G C E A]` tuning reentrant (G4 C4 E4 A4). Sin cuerdas mudas (-1).

**Cobertura:** 19 tipos × 12 raíces cromáticas (17 entradas por tipo incluyendo enarmónicos).

### Formato de entrada (ambas DBs)
```js
{ frets: [int,...], fingers: [int,...], barre: null | {f: fretNum, a: strStart, b: strEnd}, pos: int }
```
- `frets`: -1=muda, 0=cuerda al aire, 1+=traste
- `fingers`: 0=al aire/muda, 1–4=dedo (1=índice … 4=meñique)
- `barre.f`: traste de la cejilla; `a`/`b`: cuerda inicio/fin (inclusivo)
- `pos`: traste donde empieza el diagrama (0 = mostrar cebilla/nut)

### lookupChord (línea ~4543)
Busca `NEN[rootSemi]+typeEn` (sharp) **o** `NEF[rootSemi]+typeEn` (flat). Por eso cada entrada enarmónica (C#/Db, D#/Eb, F#/Gb, G#/Ab, A#/Bb) necesita ambas variantes en el DB.

## Ukulele — fórmulas de posición
- **Tuning GCEA**: G=67, C=60, E=64, A=69 (MIDI). G es reentrant (agudo, no el más grave).
- Moveable shapes comunes en UDB:
  - Major: `[n+2,n+1,n,n]` root en A+n
  - Minor: `[n+2,n,n,n]` root en A+n  
  - mM7: `[n+1,n,n,n]` root en A+n
  - m7/6th barre: `[n,n,n,n]` root en C+n (m7) o C+n (6th)
  - maj7: `[n,n,n,n+2]` root en C+n
  - Power(5): `[n,n,n+3,n+3]` root en C+n
  - dom9: `[n,n+2,n,n+1]` root en C+n
  - m9: `[n,n,n,n+2]` root en A+n
  - maj9: `[n,n+2,n,n+2]` root en C+n

## Convenciones de commits
- Siempre hacer commit + push después de cada cambio, sin pedir confirmación.
- Prefijos: `Feat:`, `Fix:`, `UX:`, `Refactor:`.
