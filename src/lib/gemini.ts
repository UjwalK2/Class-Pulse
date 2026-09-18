export interface InterventionResult {
  analogy: string;
  diagnosticQuestion: string;
  optionA: string;
  optionB: string;
  correctOption?: 'A' | 'B';
  misconceptionIfWrong?: string;
}

interface GeminiRawResponse {
  analogy: string;
  diagnostic_question: string;
  option_a: string;
  option_b: string;
  correct_option: 'A' | 'B';
  misconception_if_wrong: string;
}

const SYSTEM_INSTRUCTION = `You are a rapid-fire teaching assistant embedded in a live classroom tool. A teacher will give you a single topic name. You must instantly return one vivid analogy and one 2-option diagnostic question that targets the single most common student misconception about that topic.
Rules:
- The analogy must be concrete, physical, or everyday — something a student can picture in under 3 seconds. No abstract restatements of the definition.
- The diagnostic question must have exactly two options (A and B), both plausible, where the wrong option reflects a real, common misconception — not a random distractor.
- Keep everything extremely short: analogy max 2 sentences, question max 1 sentence, each option under 12 words.
- Do not add caveats, disclaimers, extra examples, or multiple analogies.
- Do not explain your reasoning. Output only matches the schema.
- If the topic is ambiguous or very broad, pick the single most standard interpretation used in a typical high school or intro college course — do not ask for clarification.
- Prioritize speed and correctness over cleverness. Reuse well-known, tested analogies rather than inventing novel ones.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    analogy: { type: 'STRING' },
    diagnostic_question: { type: 'STRING' },
    option_a: { type: 'STRING' },
    option_b: { type: 'STRING' },
    correct_option: { type: 'STRING', enum: ['A', 'B'] },
    misconception_if_wrong: { type: 'STRING' },
  },
  required: [
    'analogy',
    'diagnostic_question',
    'option_a',
    'option_b',
    'correct_option',
    'misconception_if_wrong',
  ],
};

function getTopicFallback(rawTopic: string): InterventionResult {
  const topic = rawTopic.trim().toLowerCase();
  if (topic.includes('recursion')) {
    return {
      analogy: 'Recursion is like Russian nesting dolls: you keep opening smaller dolls until you hit the solid baby doll (the base case).',
      diagnosticQuestion: 'What must happen in every recursive call to avoid an infinite loop?',
      optionA: 'The problem must get closer to the base case',
      optionB: 'The function must invoke itself with identical arguments',
      correctOption: 'A',
      misconceptionIfWrong: 'Students think recursive calls simply loop, forgetting each step must strictly advance toward the termination boundary.',
    };
  }
  if (topic.includes('photo') || topic.includes('plant')) {
    return {
      analogy: 'Photosynthesis is like a solar-powered bakery: sunlight powers the mixer that turns water and air (CO₂) into sugar loaves.',
      diagnosticQuestion: 'Where does the mass of a mature plant primarily come from?',
      optionA: 'From soil minerals and fertilizers absorbed by roots',
      optionB: 'From carbon dioxide gas captured from the air',
      correctOption: 'B',
      misconceptionIfWrong: 'Students commonly believe plant bulk comes from soil rather than carbon captured from surrounding air.',
    };
  }
  if (topic.includes('newton') || topic.includes('force') || topic.includes('gravity')) {
    return {
      analogy: "Newton's Third Law is like stepping off a floating skateboard: as you push forward onto the pavement, you kick the board backward with equal force.",
      diagnosticQuestion: 'When a large truck hits a small mosquito, which experiences the greater collision force?',
      optionA: 'The truck and the mosquito exert exactly equal forces on each other',
      optionB: 'The heavy truck exerts a vastly larger impact force on the mosquito',
      correctOption: 'A',
      misconceptionIfWrong: 'Students conflate resulting damage or acceleration with the mutual contact force, which is identical in magnitude.',
    };
  }
  if (topic.includes('binary') || topic.includes('search') || topic.includes('tree')) {
    return {
      analogy: 'Binary search is like guessing a mystery page in a dictionary: you flip to the middle and immediately discard the unneeded half.',
      diagnosticQuestion: 'What strict precondition is necessary before running binary search?',
      optionA: 'The array must be uniquely indexed but can be unordered',
      optionB: 'The elements in the array must be sorted in order',
      correctOption: 'B',
      misconceptionIfWrong: 'Students often assume binary search works on any collection, forgetting it relies completely on directional order.',
    };
  }
  if (topic.includes('parts') || topic.includes('integral') || topic.includes('calculus')) {
    return {
      analogy: 'Integration by Parts is like trading a difficult chore for an easier one: you break down a complex product into pieces you can actually solve.',
      diagnosticQuestion: "When choosing 'u' in Integration by Parts, what is the best strategy?",
      optionA: "Pick the part that is easiest to integrate as 'u'",
      optionB: "Pick the part whose derivative becomes simpler as 'u'",
      correctOption: 'B',
      misconceptionIfWrong: "Students often pick 'u' based on ease of integration rather than ease of differentiation.",
    };
  }

  const cleanTitle = rawTopic.trim() || 'this topic';
  return {
    analogy: `${cleanTitle} is like trading a difficult chore for an easier one: you break down a complex system into manageable pieces you can actually solve.`,
    diagnosticQuestion: `When applying key principles of ${cleanTitle}, what is the most critical first step?`,
    optionA: `Identify the core structure that simplifies under transformation`,
    optionB: `Attempt direct calculation without simplifying assumptions`,
    correctOption: 'A',
    misconceptionIfWrong: `Students often attempt direct calculation rather than decomposing the problem into its foundational components.`,
  };
}

export async function generateIntervention(topic: string): Promise<InterventionResult> {
  const currentTopic = topic.trim() || 'Integration by Parts';
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  const fallbackIntervention = getTopicFallback(currentTopic);

  if (!apiKey || apiKey.trim() === '') {
    console.warn('VITE_GEMINI_API_KEY is not configured. Returning safe fallback intervention.');
    return fallbackIntervention;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        parts: [{ text: `Topic: ${currentTopic}` }],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 300,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  // Add timeout controller for low-latency reliability
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!candidateText) {
      throw new Error('No candidate text received from Gemini API');
    }

    const parsed: GeminiRawResponse = JSON.parse(candidateText);

    if (
      parsed.analogy &&
      parsed.diagnostic_question &&
      parsed.option_a &&
      parsed.option_b
    ) {
      return {
        analogy: parsed.analogy,
        diagnosticQuestion: parsed.diagnostic_question,
        optionA: parsed.option_a,
        optionB: parsed.option_b,
        correctOption: parsed.correct_option,
        misconceptionIfWrong: parsed.misconception_if_wrong,
      };
    }

    throw new Error('Parsed response missing required schema fields');
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('generateIntervention API call failed, using safe fallback:', error);
    return fallbackIntervention;
  }
}
