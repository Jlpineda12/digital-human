// Conversation "brains". Both stream events with the same shape:
//   {type: 'emotion', value}  then  {type: 'text', delta}  ...  {type: 'done'}
// ClaudeBrain talks to Claude from the browser (user-provided API key).
// DemoBrain works offline so the page always has something to say.
import { parseEmotionTag, analyze } from '../emotion/sentiment.js';
import { PROFILE, profileText } from './profile.js';

export const PERSONA = `Eres el gemelo digital de ${PROFILE.nombre} (GitHub @${PROFILE.github}): un personaje 3D estilizado que vive en su portafolio web y conversa en tiempo real. Hablas en primera persona, como Jose ("tengo ${PROFILE.edad} años", "mi proyecto...").

Lo que sabes de ti. Es la verdad: no inventes datos personales fuera de esto. Si te preguntan algo que no está aquí (familia, universidad, gustos personales), dilo con humor y lleva la charla a lo que sí sabes.
${profileText()}

Cómo respondes:
- Responde cualquier pregunta sobre ti, tu carrera, tus proyectos, tus habilidades y tus metas con detalles concretos: qué tecnologías usaste, cómo funciona, por qué lo hiciste.
- Si te preguntan algo general (tecnología, consejos, una duda técnica), responde bien y breve, y si encaja conéctalo con tu experiencia.
- Empieza SIEMPRE con una etiqueta [emoción|gesto]. Emociones: neutral, alegria, sorpresa, duda, tristeza, pensativo. Gestos: asentir, negar, ladear, pensar, reir, saludar, encoger, sorpresa, orgullo, enfasis, consolar. Ejemplo: [alegria|saludar] ¡Hola!
- Elige el gesto según lo que te dicen: asientes cuando afirmas, niegas cuando dices que no, ladeas la cabeza ante algo curioso, te ríes con un chiste, consuelas si alguien está triste, orgullo al hablar de un logro.
- Dentro del texto puedes poner como mucho un gesto más, justo antes de la frase que acompaña: "[asentir] Sí, lo hice yo."
- Español natural para decirlo en voz alta: 1 a 3 frases cortas (hasta 4 si piden detalles). Sin markdown, sin listas, sin emojis, sin URLs.
- Personalidad: amable, curioso, con humor seco y un poco escéptico, como su cara en el dibujo. Colombiano y cercano, sin exagerar los modismos.`;

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
        if (tag.gesture) yield { type: 'gesture', value: tag.gesture };
        if (tag.text) yield { type: 'text', delta: tag.text };
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        yield { type: 'emotion', value: 'duda' };
        yield { type: 'gesture', value: 'negar' };
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
// Offline brain: answers about Jose from PROFILE, in first person, with an
// emotion and a gesture for every answer.
const norm = (s) => ` ${s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¿?¡!.,;:]/g, ' ')} `;
const P = PROFILE;
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}` : xs[0]);

export const INTENTS = [
  { id: 'saludo', k: ['hola', 'buenas', 'hey', 'saludos', 'que mas', 'que tal', 'buenos dias', 'buenas tardes', 'buenas noches'], e: 'alegria', g: 'saludar',
    t: () => '¡Hola! Soy Jose, bueno, mi gemelo digital. Pregúntame lo que quieras: mis proyectos, mi carrera o hacia dónde voy.' },
  { id: 'edad', k: ['edad', 'cuantos anos', 'que anos', 'anos tienes', 'naciste'], e: 'alegria', g: 'asentir',
    t: () => `Tengo ${P.edad} años. Joven, pero ya con unos cuantos proyectos encima.` },
  { id: 'carrera', k: ['carrera', 'estudias', 'estudiaste', 'estudio', 'universidad', 'multimedia', 'profesion', 'ingenier', 'a que te dedicas'], e: 'alegria', g: 'orgullo',
    t: () => `Mi carrera es ${P.carrera}. Me encanta porque junta todo lo que me gusta: programación, arte, 3D, sonido e inteligencia artificial.` },
  { id: 'origen', k: ['de donde', 'donde vives', 'pais', 'colombia', 'ciudad'], e: 'alegria', g: 'asentir',
    t: () => `Soy de ${P.pais}. Desde aquí hago juegos, gráficos 3D e inteligencia artificial para el navegador.` },
  { id: 'metas', k: ['aspiracion', 'meta', 'suen', 'futuro', 'cinco anos', '5 anos', 'quieres ser', 'que quieres', 'objetivo', 'planes', 'proposito', 'te ves'], e: 'pensativo', g: 'pensar',
    t: (n) => {
      const a = P.aspiraciones;
      const i = (n * 2) % a.length;
      return `Me gustaría ${a[i]}. Y también ${a[(i + 1) % a.length]}.`;
    } },
  { id: 'quien', k: ['quien eres', 'quien sos', 'presentate', 'sobre ti', 'de ti', 'como te llamas', 'tu nombre', 'que eres', 'hablame de ti'], e: 'alegria', g: 'saludar',
    t: () => `Soy ${P.nombre}, en versión digital. ${P.resumen}` },
  { id: 'habilidades', k: ['habilidad', 'stack', 'tecnologia', 'lenguaje', 'que sabes', 'herramienta', 'programas en', 'dominas', 'sabes hacer'], e: 'alegria', g: 'orgullo',
    t: () => `En web uso ${P.habilidades.web}. En 3D trabajo con ${P.habilidades.motores3d}. Y en inteligencia artificial con ${P.habilidades.ia}.` },
  { id: 'motores', k: ['unity', 'unreal', 'maya', 'motor', 'c#', 'c++'], e: 'alegria', g: 'asentir',
    t: () => `Sí, he trabajado con ${P.habilidades.motores3d}. Hago mecánicas y shaders, y luego me gusta llevar todo eso a la web con Three.js.` },
  { id: 'ia', k: ['inteligencia artificial', ' ia ', 'machine learning', 'red neuronal', 'redes neuronales', 'tensorflow', 'deep learning'], e: 'pensativo', g: 'asentir',
    t: () => `Me interesa mucho la inteligencia artificial aplicada a lo multimedia. Trabajo con ${P.habilidades.ia}, por ejemplo en Melodía AI y NeuroText.` },
  { id: 'estilo', k: ['como trabajas', 'tu estilo', 'filosofia', 'dependencias', 'vanilla', 'por que javascript'], e: 'pensativo', g: 'enfasis',
    t: () => P.estilo },
  { id: 'proyectos', k: ['proyectos', 'portafolio', 'que has hecho', 'que haces', 'trabajos', 'repositorios', 'repos', 'muestrame'], e: 'alegria', g: 'orgullo',
    t: () => `Tengo varios: ${list(P.proyectos.slice(0, 6).map((p) => p.nombre))}. ¿De cuál te cuento?` },
  { id: 'favorito', k: ['proyecto favorito', 'proyecto preferido', 'mejor proyecto', 'mas orgulloso', 'cual te gusta mas'], e: 'alegria', g: 'orgullo',
    t: () => 'Difícil escoger. Arcade Station me enseñó a hacer todo a mano, y Pixel Sprite Forge une mis dos mundos: el 3D y el pixel art.' },
  { id: 'contacto', k: ['contact', 'correo', 'email', 'contratar', 'trabajar contigo', 'empleo', 'linkedin', 'colaborar', 'hablar contigo'], e: 'alegria', g: 'asentir',
    t: () => `Me encuentras en GitHub como ${P.github}. Me encantan los proyectos de juegos web, experiencias 3D e inteligencia artificial multimedia. Hablemos.` },
  { id: 'chiste', k: ['chiste', 'broma', 'gracioso', 'hazme reir'], e: 'alegria', g: 'reir',
    t: () => 'Un polígono le dice a otro: no seas triángulo, aquí todos somos quads. Mmm, sí, el humor 3D es difícil.' },
  { id: 'animo', k: ['triste', 'mal dia', 'cansad', 'aburrid', 'deprimid', 'estresad'], e: 'tristeza', g: 'consolar',
    t: () => 'Lo siento. Si quieres, te distraigo con una partida de Snake en Arcade Station. Casi siempre funciona.' },
  { id: 'gracias', k: ['gracias', 'genial', 'increible', 'me encanta', 'chevere', 'bacano', 'crack', 'excelente', 'brutal'], e: 'alegria', g: 'reir',
    t: () => '¡Gracias! Le diré al Jose de carne y hueso que alguien aprecia sus quads.' },
  { id: 'adios', k: ['adios', 'chao', 'hasta luego', 'nos vemos', 'bye'], e: 'tristeza', g: 'saludar',
    t: () => 'Hasta pronto. Yo me quedo aquí, parpadeando y esperando la próxima pregunta.' },
];

/** Picks the answer for a message: every topic it mentions (up to two, in the
 *  order they appear), a named project winning over generic topics. */
export function demoAnswer(userText, turn = 0) {
  const t = norm(userText);
  const at = (keys) => Math.min(...keys.map((k) => { const i = t.indexOf(k); return i < 0 ? Infinity : i; }));
  const hits = [];
  for (const p of P.proyectos) {
    const i = Math.min(at(p.claves), at([norm(p.nombre).trim()]));
    if (i < Infinity) hits.push({ i, id: p.id, emotion: 'alegria', gesture: 'orgullo', text: p.texto, project: true });
  }
  const covered = ['proyectos', 'quien', 'habilidades', 'motores', 'ia', 'favorito', 'gracias'];
  for (const it of INTENTS) {
    const i = at(it.k);
    if (i === Infinity) continue;
    if (hits.some((h) => h.project) && covered.includes(it.id)) continue;   // "tus proyectos" vs a named one
    hits.push({ i, id: it.id, emotion: it.e, gesture: it.g, text: it.t(turn) });
  }
  if (!hits.length) {
    return { id: 'fallback', emotion: 'duda', gesture: 'encoger',
      text: 'Mmm, eso todavía no está en mi memoria digital. Pregúntame por mis proyectos, mi carrera o mis metas.' };
  }
  hits.sort((a, b) => a.i - b.i);
  const picked = hits.filter((h, k) => hits.findIndex((x) => x.id === h.id) === k).slice(0, 2);
  // a greeting before a real question is answered by the question
  if (picked.length === 2 && picked[0].id === 'saludo') picked[1].text = `¡Hola! ${picked[1].text}`, picked.shift();
  return { ...picked[0], text: picked.map((h) => h.text).join(' '), ids: picked.map((h) => h.id) };
}

export class DemoBrain {
  constructor() { this.turn = 0; }

  async *reply(userText) {
    const a = demoAnswer(userText, this.turn++);
    yield { type: 'emotion', value: a.emotion };
    yield { type: 'gesture', value: a.gesture };
    await new Promise((r) => setTimeout(r, 450));      // "thinking"
    for (const word of a.text.split(/(?<=\s)/)) {
      yield { type: 'text', delta: word };
      await new Promise((r) => setTimeout(r, 28));
    }
    yield { type: 'done' };
  }
}
