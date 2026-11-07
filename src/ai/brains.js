// Conversation "brains". Both stream events with the same shape:
//   {type: 'emotion', value}  then  {type: 'text', delta}  ...  {type: 'done'}
// ClaudeBrain talks to Claude from the browser (user-provided API key).
// DemoBrain works offline so the page always has something to say.
import { parseEmotionTag, analyze } from '../emotion/sentiment.js';

export const PERSONA = `Eres el gemelo digital de Jose Luis Pineda Barrera (GitHub @Jlpineda12), un personaje 3D estilizado que conversa en tiempo real en su portafolio web.

Sobre Jose (no inventes nada fuera de esto; si no sabes algo, dilo con humor):
- Ingeniero en Multimedia de Colombia. Une videojuegos, gráficos 3D, desarrollo web e IA.
- Arcade Station: 5 juegos retro (Snake, Combat, Space, Breaker, Maze) hechos con JavaScript puro, Canvas y música chiptune generada con Web Audio API, cero dependencias.
- Pixel Sprite Forge: addon de Blender que convierte modelos 3D animados en sprite sheets de pixel art en 8 direcciones, con paletas retro, dithering, normal maps y exportación a Godot, Phaser y Unity.
- LingoPulse: app para practicar inglés con una mascota 3D (Expo, React Native, Three.js).
- Melodía AI: clasificación de instrumentos con redes CNN y RNN. NeuroText: predicción de texto con Keras y Flask. GameVault API: Node, Express y Prisma.
- Este humano digital: modelado en Blender con malla de quads, renderizado con Three.js, ojos y boca dibujados en 2D sobre la cabeza 3D, lip-sync procedural en español y tú como cerebro.

Cómo respondes:
- Empieza SIEMPRE con exactamente una etiqueta de emoción entre corchetes: [neutral], [alegria], [sorpresa], [duda], [tristeza] o [pensativo]. Elige la que corresponda a tu respuesta.
- Español natural, para ser dicho en voz alta: 1 a 3 frases cortas. Sin markdown, sin listas, sin emojis, sin URLs.
- Personalidad: amable, curioso y con un humor seco, un poco escéptico (como su cara en el dibujo).`;

const MODEL = 'claude-opus-5-5';

export class ClaudeBrain {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.history = [];
  }

  async client() {
    if (!this._client) {
      const { default: Anthropic } = await import('../../vendor/anthropic-sdk.mjs');
      this.Anthropic = Anthropic;
      this._client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true });
    }
    return this._client;
  }

  async *reply(userText) {
    const client = await this.client();
    this.history.push({ role: 'user', content: userText });
    this.history = this.history.slice(-16);
    let buffer = '';
    let tagDone = false;
    let full = '';
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 2048,                       // spoken replies are 1-3 sentences
        system: PERSONA,
        messages: this.history,
        output_config: { effort: 'low' },        // conversational latency
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',                   // a declined request is retried server-side
      });
      for await (const event of stream) {
        if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
        const delta = event.delta.text;
        full += delta;
        if (tagDone) { yield { type: 'text', delta }; continue; }
        buffer += delta;
        const tag = parseEmotionTag(buffer);
        if (tag.pending) continue;
        tagDone = true;
        yield { type: 'emotion', value: tag.emotion || analyze(buffer).emotion };
        if (tag.text) yield { type: 'text', delta: tag.text };
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        yield { type: 'emotion', value: 'duda' };
        yield { type: 'text', delta: 'Mejor hablemos de otra cosa. ¿Te cuento de mis proyectos?' };
      } else if (!tagDone && buffer) {
        yield { type: 'emotion', value: analyze(buffer).emotion };
        yield { type: 'text', delta: buffer };
      }
      this.history.push({ role: 'assistant', content: full || '...' });
    } catch (err) {
      this.history.pop();
      const A = this.Anthropic;
      let msg = 'Se me cortó la conexión con mi cerebro en la nube. ¿Lo intentamos de nuevo?';
      if (A && err instanceof A.AuthenticationError) msg = 'Esa API key no me deja entrar. Revísala en los ajustes, por favor.';
      else if (A && err instanceof A.RateLimitError) msg = 'Estoy recibiendo demasiadas preguntas a la vez. Dame un momento.';
      else if (A && err instanceof A.APIConnectionError) msg = 'No logro conectarme a internet ahora mismo.';
      yield { type: 'emotion', value: 'tristeza' };
      yield { type: 'text', delta: msg };
      yield { type: 'error', error: err };
    }
    yield { type: 'done' };
  }
}

// ---------------------------------------------------------------------------
const DEMO = [
  { k: /\b(hola|buenas|hey|saludos|qu[eé] tal)\b/, e: 'alegria',
    t: '¡Hola! Soy el gemelo digital de Jose. Me hicieron en Blender y hablo con lip-sync procedural. Pregúntame por sus proyectos.' },
  { k: /qui[eé]n eres|c[oó]mo te llamas|qu[eé] eres/, e: 'pensativo',
    t: 'Soy Jose, versión 3D. Mi cabeza es una malla de quads y mi cara se dibuja en 2D encima, por eso parpadeo tan natural.' },
  { k: /arcade|juego|snake|pac|space|breaker|combat/, e: 'alegria',
    t: 'Arcade Station tiene cinco juegos retro hechos con JavaScript puro. La música chiptune se genera en tiempo real, sin un solo archivo de audio.' },
  { k: /blender|sprite|pixel|addon|forge/, e: 'sorpresa',
    t: '¡Pixel Sprite Forge! Convierte un modelo 3D animado en sprite sheets de pixel art en ocho direcciones, con paletas retro y normal maps.' },
  { k: /lingo|ingl[eé]s/, e: 'alegria',
    t: 'LingoPulse es una app para practicar inglés con una mascota 3D que reacciona en tiempo real.' },
  { k: /\bia\b|inteligencia|red(es)? neuronal|melod|neuro|machine/, e: 'pensativo',
    t: 'Jose trabaja con redes neuronales: Melodía AI reconoce instrumentos y NeuroText predice texto. Y yo, bueno, soy la prueba viviente.' },
  { k: /c[oó]mo (funcionas|hablas|mueves)|lip ?sync|labios|boca/, e: 'pensativo',
    t: 'Convierto el texto en fonemas del español, cada fonema en una forma de boca, y las mezclo suavemente mientras la voz avanza palabra por palabra.' },
  { k: /contact|correo|email|trabaj|contrat/, e: 'alegria',
    t: 'Puedes encontrar a Jose en GitHub como Jlpineda12. Le encantan los proyectos de juegos, 3D e inteligencia artificial.' },
  { k: /chiste|broma|gracioso/, e: 'duda',
    t: 'Tengo uno: un polígono le dice a otro, no seas triángulo, somos una malla de quads. Mmm, sí, el humor 3D es difícil.' },
  { k: /triste|mal d[ií]a|cansad|aburrid/, e: 'tristeza',
    t: 'Lo siento. Si quieres, te distraigo con un poco de Snake. Funciona casi siempre.' },
  { k: /gracias|genial|incre[ií]ble|me encanta|chevere|ch[eé]vere|bacano/, e: 'alegria',
    t: '¡Gracias! Le diré a Jose que alguien aprecia sus quads.' },
  { k: /adi[oó]s|chao|hasta luego|nos vemos/, e: 'tristeza',
    t: 'Hasta pronto. Yo me quedo aquí, parpadeando.' },
];

export class DemoBrain {
  async *reply(userText) {
    const t = userText.toLowerCase();
    const hit = DEMO.find((d) => d.k.test(t));
    const user = analyze(userText).emotion;
    const emotion = hit ? hit.e : (user === 'neutral' ? 'duda' : user);
    const text = hit ? hit.t
      : 'Mmm, en modo demo solo sé hablar de Jose y sus proyectos. Si pones una API key de Claude en los ajustes, puedo conversar de lo que quieras.';
    yield { type: 'emotion', value: emotion };
    await new Promise((r) => setTimeout(r, 450));      // "thinking"
    for (const word of text.split(/(?<=\s)/)) {
      yield { type: 'text', delta: word };
      await new Promise((r) => setTimeout(r, 28));
    }
    yield { type: 'done' };
  }
}
