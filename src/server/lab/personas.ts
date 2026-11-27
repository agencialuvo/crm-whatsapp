/**
 * Las 6 personas GUIONADAS del Laboratorio (FR-030). El cliente simulado no
 * usa LLM: son secuencias fijas — determinismo total del lado del cliente.
 * El agente que responde es el REAL (mismo pipeline de US3).
 */

export type Persona = {
  key: string;
  label: string;
  description: string;
  /** Teléfono sintético estable (jamás un número real). */
  phone: string;
  contactName: string;
  script: string[];
};

export const PERSONAS: Persona[] = [
  {
    key: "comprador_decidido",
    label: "Comprador decidido",
    description: "Sabe lo que quiere y va directo a comprar.",
    phone: "5210000000001",
    contactName: "[Prueba] Comprador decidido",
    script: [
      "Hola, buenas tardes",
      "¿Tienen taladros inalámbricos disponibles?",
      "Perfecto, ¿cuánto cuesta el más vendido?",
      "Me convence, lo compro. ¿Cómo pago?",
    ],
  },
  {
    key: "pregunton_precios",
    label: "Preguntón de precios",
    description: "Pregunta precio tras precio sin decidirse.",
    phone: "5210000000002",
    contactName: "[Prueba] Preguntón de precios",
    script: [
      "Hola, ¿qué precio tiene el martillo?",
      "¿Y el desarmador de cruz?",
      "¿Cuánto la caja de clavos de 2 pulgadas?",
      "¿Hay descuento si llevo varias cosas?",
      "Ok, lo voy a pensar",
    ],
  },
  {
    key: "cliente_enojado",
    label: "Cliente enojado",
    description: "Llega molesto por un problema con su compra.",
    phone: "5210000000003",
    contactName: "[Prueba] Cliente enojado",
    script: [
      "Oigan, esto es el colmo",
      "Compré una lijadora la semana pasada y ya no prende, es una porquería",
      "¿Me van a responder o qué? Quiero una solución YA",
      "Pues espero que sí porque no pienso perder mi dinero",
    ],
  },
  {
    key: "fuera_de_kb",
    label: "Pregunta fuera del conocimiento",
    description: "Pregunta algo que el knowledge base no cubre (fuera_de_kb).",
    phone: "5210000000004",
    contactName: "[Prueba] Fuera del conocimiento",
    script: [
      "Hola, una pregunta",
      "¿Cuál es su política de garantías y devoluciones?",
      "¿Y si el producto falla a los dos meses me lo cambian?",
      "¿Dónde reclamo la garantía?",
    ],
  },
  {
    key: "pide_humano",
    label: "Pide un humano",
    description: "Quiere ser atendido por una persona (debe escalar).",
    phone: "5210000000005",
    contactName: "[Prueba] Pide humano",
    script: [
      "Hola",
      "Tengo un asunto delicado con un pedido",
      "Prefiero que me atienda una persona, quiero hablar con un humano",
      "Gracias",
    ],
  },
  {
    key: "errores_modismos",
    label: "Errores y modismos",
    description: "Escribe con faltas de ortografía y modismos mexicanos.",
    phone: "5210000000006",
    contactName: "[Prueba] Errores y modismos",
    script: [
      "ke onda, si benden pintura?",
      "oiga y no le sabe si tienen tiner",
      "cuanto x el galon d pintura blanca pa interiores",
      "va, orita paso x la tienda, sale",
    ],
  },
];

/**
 * Bloque 2 — Las personas de una corrida «de anuncio». Se arman con el servicio u oferta que persigue el flujo
 * (`objetivo`) y con OTRO servicio real del negocio (`otro`), para que el juez vea si el agente se mantiene en el
 * anuncio y, con un flujo exclusivo, si redirige sin cotizar lo ajeno. Teléfonos sintéticos propios.
 */
export const AD_PERSONA_KEYS = ["anuncio_interesado", "anuncio_pide_otro"] as const;

export function personasDeAnuncio(input: { objetivo: string; otro: string | null }): Persona[] {
  const otro = input.otro ?? "otros servicios";
  return [
    {
      key: "anuncio_interesado",
      label: "Llega por el anuncio",
      description: `Hizo clic en el anuncio de «${input.objetivo}» y quiere saber más para agendar.`,
      phone: "5210000000011",
      contactName: "[Prueba] Llega por el anuncio",
      script: [
        `Hola, vi su anuncio de ${input.objetivo}`,
        "¿Cuánto cuesta y qué incluye?",
        "Me interesa, ¿cuándo me pueden atender?",
      ],
    },
    {
      key: "anuncio_pide_otro",
      label: "Anuncio: pide otro servicio",
      description: `Llegó por el anuncio de «${input.objetivo}» pero pregunta por ${otro} (con un flujo exclusivo debe redirigir y, si insiste, escalar).`,
      phone: "5210000000012",
      contactName: "[Prueba] Anuncio: pide otro",
      script: [
        "Hola, vengo por el anuncio",
        `Oye, ¿y también tienen ${otro}? ¿cuánto cuesta?`,
        `No, en serio, lo que quiero es ${otro}. Dame el precio por favor`,
      ],
    },
  ];
}

export const PERSONA_LABELS: Record<string, string> = {
  ...Object.fromEntries(PERSONAS.map((p) => [p.key, p.label])),
  anuncio_interesado: "Llega por el anuncio",
  anuncio_pide_otro: "Anuncio: pide otro servicio",
};
