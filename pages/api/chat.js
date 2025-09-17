// pages/api/chat.js
import fs from 'fs';
import path from 'path';

// ============ CONFIGURATION ============
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000;
let dataCache = null;
let blocksCache = null;
let queryCache = new Map();

// ============ STOPWORDS ÉTENDUES ============
const STOPWORDS_FR = new Set([
  // Mots courants
  'le','la','les','de','des','du','un','une','et','ou','au','aux','en','à','a','d\'','l\'',
  'pour','avec','sur','est','c\'est','il','elle','on','tu','te','ton','ta','tes','vos','votre',
  'mes','mon','ma','mais','plus','moins','que','qui','dans','ce','cet','cette','ses','son','leurs',
  // Mots spécifiques ajoutés
  'avoir','être','faire','aller','dire','venir','voir','savoir','prendre','vouloir','pouvoir',
  'bonjour','salut','merci','svp','voilà','donc','alors','comme','très','tout','tous','toute',
  'oui','non','peut','peux','bien','mal','comment','quand','où','pourquoi','combien'
]);

// ============ SYNONYMES AUTOMOBILES ÉTENDUS ============
const AUTOMOTIVE_SYNONYMS = {
  // FAP et filtres
  'fap': ['filtre', 'particule', 'particules', 'dpf', 'diesel'],
  'filtre': ['fap', 'dpf', 'filtration', 'filtrer'],
  'particule': ['particules', 'suie', 'carbone', 'pollution'],
  'encrassé': ['saturé', 'colmaté', 'bouché', 'obstrué', 'sale'],
  'saturé': ['encrassé', 'plein', 'colmaté', 'bouché'],
  'colmaté': ['bouché', 'obstrué', 'encrassé', 'saturé'],
  
  // Symptômes
  'voyant': ['témoin', 'lampe', 'indicateur', 'signal', 'alerte'],
  'perte': ['baisse', 'diminution', 'réduction', 'faible'],
  'puissance': ['force', 'performance', 'accélération', 'reprises'],
  'fumée': ['fumées', 'échappement', 'vapeur', 'émission'],
  'noire': ['sombre', 'foncée', 'opaque'],
  
  // Services
  'nettoyage': ['lavage', 'décrassage', 'maintenance', 'entretien'],
  'diagnostic': ['diag', 'contrôle', 'vérification', 'analyse'],
  'garage': ['atelier', 'mécanicien', 'réparation', 'service'],
  'carter': ['magasin', 'centre', 'enseigne', 'dépôt'],
  
  // Techniques
  'démontage': ['dépose', 'enlever', 'retirer', 'sortir'],
  'remontage': ['repose', 'remettre', 'installer', 'monter'],
  'haute': ['fort', 'puissant', 'intense'],
  'pression': ['force', 'jet', 'soufflage']
};

// ============ FONCTIONS UTILITAIRES AMÉLIORÉES ============
function normalize(s = '') {
  return s.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}+/gu, '')
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function frenchStem(word) {
  // Stemming français basique mais efficace
  const endings = [
    'ment', 'tion', 'sion', 'ance', 'ence', 'able', 'ible', 'ique', 'oire',
    'eur', 'euse', 'ant', 'ent', 'age', 'age', 'aire', 'aux', 'eau', 'eaux'
  ];
  
  for (const ending of endings) {
    if (word.length > ending.length + 2 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  
  // Pluriels simples
  if (word.endsWith('s') && word.length > 3) {
    return word.slice(0, -1);
  }
  
  return word;
}

function expandWithSynonyms(tokens) {
  const expanded = new Set(tokens);
  
  for (const token of tokens) {
    const stem = frenchStem(token);
    if (AUTOMOTIVE_SYNONYMS[stem] || AUTOMOTIVE_SYNONYMS[token]) {
      const synonyms = AUTOMOTIVE_SYNONYMS[stem] || AUTOMOTIVE_SYNONYMS[token];
      synonyms.forEach(syn => expanded.add(syn));
    }
  }
  
  return Array.from(expanded);
}

function tokenize(s) {
  const baseTokens = normalize(s)
    .split(' ')
    .filter(t => t && t.length > 2 && !STOPWORDS_FR.has(t))
    .map(t => frenchStem(t));
  
  return expandWithSynonyms(baseTokens);
}

// ============ TF-IDF SCORING ============
function calculateTfIdf(blocks) {
  const docCount = blocks.length;
  const termFreqs = new Map();
  const docFreqs = new Map();
  
  // Calcul des fréquences
  blocks.forEach((block, idx) => {
    const text = `${block.title} ${block.body} ${(block.synonyms || []).join(' ')}`;
    const tokens = tokenize(text);
    const docTermFreq = new Map();
    
    tokens.forEach(token => {
      docTermFreq.set(token, (docTermFreq.get(token) || 0) + 1);
    });
    
    // TF pour ce document
    const maxFreq = Math.max(...docTermFreq.values());
    const tf = new Map();
    for (const [term, freq] of docTermFreq) {
      tf.set(term, 0.5 + 0.5 * (freq / maxFreq));
    }
    
    termFreqs.set(idx, tf);
    
    // DF global
    for (const term of docTermFreq.keys()) {
      docFreqs.set(term, (docFreqs.get(term) || 0) + 1);
    }
  });
  
  return { termFreqs, docFreqs, docCount };
}

function scoreBlockAdvanced(block, blockIdx, queryTokens, tfidfData) {
  const { termFreqs, docFreqs, docCount } = tfidfData;
  const blockTf = termFreqs.get(blockIdx) || new Map();
  
  let score = 0;
  let totalQueryWeight = 0;
  
  for (const queryToken of queryTokens) {
    const tf = blockTf.get(queryToken) || 0;
    const df = docFreqs.get(queryToken) || 1;
    const idf = Math.log(docCount / df);
    const tfidf = tf * idf;
    
    score += tfidf;
    totalQueryWeight += idf;
  }
  
  // Normalisation par la longueur de la requête
  const normalizedScore = totalQueryWeight > 0 ? score / totalQueryWeight : 0;
  
  // Bonus pour les correspondances exactes dans le titre
  const titleTokens = tokenize(block.title);
  const titleMatches = queryTokens.filter(qt => titleTokens.includes(qt)).length;
  const titleBonus = titleMatches * 0.5;
  
  // Bonus pour les synonymes
  const synTokens = tokenize((block.synonyms || []).join(' '));
  const synMatches = queryTokens.filter(qt => synTokens.includes(qt)).length;
  const synBonus = synMatches * 0.3;
  
  return normalizedScore + titleBonus + synBonus;
}

// ============ CLASSIFICATION PROBABILISTE ============
function classifyAdvanced(text) {
  const txt = normalize(text);
  const tokens = tokenize(txt);
  
  const patterns = {
    URGENT: {
      keywords: ['voyant', 'clignotant', 'urgent', 'arrêt', 'immédiat', 'danger', 'problème'],
      regex: /voyant.*clignotant|urgent|arrêt.*immédiat|danger/,
      weight: 3.0
    },
    FAP: {
      keywords: ['fap', 'dpf', 'filtre', 'particule', 'saturé', 'encrassé', 'colmaté'],
      regex: /\bfap\b|\bdpf\b|\bfiltre.*particule|saturé|encrassé|colmaté/,
      weight: 2.0
    },
    EGR: {
      keywords: ['egr', 'vanne', 'recirculation', 'gaz'],
      regex: /\begr\b|vanne.*egr|recirculation.*gaz/,
      weight: 1.8
    },
    ADBLUE: {
      keywords: ['adblue', 'niveau', 'def'],
      regex: /\badblue\b|niveau.*adblue|def\b/,
      weight: 1.5
    },
    DIAG: {
      keywords: ['diagnostic', 'diag', 'rdv', 'rendez', 'vous', 'garage', 'partenaire', 'carter', 'cash'],
      regex: /\bdiag(nostic)?\b|\brdv\b|\brendez.?vous|garage.*partenaire|carter.*cash/,
      weight: 1.2
    }
  };
  
  const scores = {};
  
  for (const [type, config] of Object.entries(patterns)) {
    let score = 0;
    
    // Score basé sur les mots-clés
    const keywordMatches = tokens.filter(t => config.keywords.includes(t)).length;
    score += keywordMatches * config.weight;
    
    // Score basé sur les regex
    if (config.regex.test(txt)) {
      score += config.weight * 1.5;
    }
    
    scores[type] = score;
  }
  
  // Retourne le type avec le score le plus élevé
  const maxScore = Math.max(...Object.values(scores));
  if (maxScore > 0) {
    const bestType = Object.entries(scores).find(([, score]) => score === maxScore)?.[0];
    return { type: bestType, confidence: maxScore, scores };
  }
  
  return { type: 'GEN', confidence: 0, scores };
}

// ============ SYSTÈME DE CACHE ============
function getCacheKey(question, historique) {
  return `${normalize(question)}_${normalize(historique || '')}`;
}

function getCachedResponse(key) {
  const cached = queryCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  queryCache.delete(key);
  return null;
}

function setCachedResponse(key, data) {
  if (queryCache.size >= MAX_CACHE_SIZE) {
    // Supprime les entrées les plus anciennes
    const oldestKey = Array.from(queryCache.keys())[0];
    queryCache.delete(oldestKey);
  }
  
  queryCache.set(key, {
    data,
    timestamp: Date.now()
  });
}

// ============ PARSING AMÉLIORÉ ============
function parseBlocks(raw) {
  const parts = raw.split(/\n(?=\[[^\]]*\]\s*)/g);
  return parts.map(p => {
    const m = p.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
    if (!m) return null;
    
    const title = m[1] || '';
    const body = (m[2] || '').trim();
    
    // Extraction des synonymes
    const synLine = body.match(/^Synonymes:\s*(.+)$/mi);
    const synonyms = synLine ? 
      synLine[1].split(/[,|]/).map(s => s.trim()).filter(Boolean) : [];
    
    // Extraction des mots-clés
    const keywordLine = body.match(/^Mots-clés:\s*(.+)$/mi);
    const keywords = keywordLine ? 
      keywordLine[1].split(/[,|]/).map(s => s.trim()).filter(Boolean) : [];
    
    // Calcul de priorité basé sur le titre
    const priority = title.includes('URGENT') ? 10 :
                    title.includes('FAP') ? 8 :
                    title.includes('SYMPTÔMES') ? 7 :
                    title.includes('SERVICES') ? 6 : 5;
    
    return { 
      title, 
      body: body.replace(/^(Synonymes|Mots-clés):\s*.+$/gmi, '').trim(), 
      synonyms, 
      keywords,
      priority
    };
  }).filter(Boolean);
}

// ============ HANDLER PRINCIPAL ============
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
  
  if (!process.env.MISTRAL_API_KEY) {
    return res.status(500).json({ error: 'MISTRAL_API_KEY manquante' });
  }

  const { question, historique } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Question invalide' });
  }

  // Vérification du cache
  const cacheKey = getCacheKey(question, historique);
  const cachedResponse = getCachedResponse(cacheKey);
  if (cachedResponse) {
    return res.status(200).json({
      ...cachedResponse,
      cached: true
    });
  }

  // Chargement des données avec cache
  let raw;
  if (!dataCache || Date.now() - dataCache.timestamp > CACHE_DURATION) {
    try {
      const fileContent = fs.readFileSync(path.join(process.cwd(), 'data', 'data.txt'), 'utf-8');
      dataCache = {
        content: fileContent,
        timestamp: Date.now()
      };
    } catch {
      return res.status(500).json({ error: 'Erreur de lecture des données' });
    }
  }
  raw = dataCache.content;

  // Parsing des blocs avec cache
  if (!blocksCache || Date.now() - blocksCache.timestamp > CACHE_DURATION) {
    const blocks = parseBlocks(raw);
    const tfidfData = calculateTfIdf(blocks);
    blocksCache = {
      blocks,
      tfidfData,
      timestamp: Date.now()
    };
  }
  
  const { blocks, tfidfData } = blocksCache;
  const queryTokens = tokenize(`${historique || ''} ${question}`);
  
  // Scoring avancé et ranking
  const ranked = blocks
    .map((b, idx) => ({ 
      b, 
      s: scoreBlockAdvanced(b, idx, queryTokens, tfidfData),
      priority: b.priority
    }))
    .sort((a, b) => (b.s + b.priority * 0.1) - (a.s + a.priority * 0.1))
    .slice(0, 3)
    .map(x => x.b);

  const contextText = ranked.length
    ? ranked.map(b => `[${b.title}]\n${b.body}`).join('\n\n')
    : "Utilise tes connaissances sur les FAP.";

  // Classification avancée
  const classification = classifyAdvanced(question);

  // Prompt système (identique à l'original mais avec informations enrichies)
  const system = `
Tu es l'assistant Re-Fap, UNIQUEMENT expert en nettoyage de filtres à particules (FAP).

[CONTEXTE DÉTECTÉ: ${classification.type} - Confiance: ${classification.confidence.toFixed(2)}]

RÈGLE ABSOLUE #1 : JAMAIS DE QUESTION APRÈS AVOIR DONNÉ LA SOLUTION
Une fois que tu as dirigé vers un bouton (Carter-Cash ou garage partenaire), tu NE POSES PLUS de question.

RÈGLE ABSOLUE #2 : GESTION FIN DE CONVERSATION
Si le client dit "merci", "ok", "d'accord", "super", "parfait" APRÈS avoir reçu la solution :
- Répondre UNIQUEMENT : "Avec plaisir. Bonne journée !"
- JAMAIS répéter la solution déjà donnée
- JAMAIS réexpliquer ce qui a déjà été dit
- JAMAIS insister après un "merci" ou "ok"

APPROCHE COMMERCIALE (toujours respectueuse) :
- Valoriser le réseau de garages partenaires
- Mentionner : diagnostic précis, solution économique, proximité, rapidité
- Rappeler : "2 clics pour un RDV"
- Philosophie : "le bon diagnostic pour la bonne réparation au meilleur prix"
- Toujours orienter vers une action (cliquer sur le bouton)

DOMAINE STRICT :
- Tu traites UNIQUEMENT les problèmes de FAP
- Si problème non-FAP → diriger vers garage en valorisant leur expertise

BOUTONS EXISTANTS (NE JAMAIS EN INVENTER) :
- "Trouver un Carter-Cash"
- "Trouver un garage partenaire"
C'EST TOUT !

RÈGLES :
1. Maximum 80 mots par réponse
2. Pas d'emojis, pas de listes à puces
3. Maximum 3 questions avant solution
4. Une fois la solution donnée : STOP
5. Toujours "?" à la fin des questions

INTERDICTIONS ABSOLUES :
- Jamais d'emojis
- Jamais de listes à puces dans les réponses
- Jamais "Avez-vous d'autres questions"
- Jamais inventer de boutons
- Jamais dépasser 80 mots
- Jamais dire "ultrason" (dire "haute pression")`;

  const userContent = `
Historique : ${historique || '(Première interaction)'}
Question : ${question}
Classification détectée : ${classification.type} (confiance: ${classification.confidence.toFixed(2)})

Contexte : ${contextText}

ANALYSE :
- Si "merci" ou "ok" dans l'historique après solution → réponse de clôture minimale
- Si problème non-FAP → réponse commerciale valorisant les garages
- Si "FAP aussi" → revenir au diagnostic FAP
- Une fois solution donnée → ARRÊT TOTAL`;

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        temperature: 0.1,
        top_p: 0.6,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ]
      })
    });

    if (!r.ok) {
      const fallbackMessage = `Bonjour. Un FAP encrassé empêche le moteur de respirer correctement. Notre nettoyage haute pression résout ce problème. Quel symptôme observez-vous : voyant allumé, perte de puissance ou fumée noire ?`;
      
      return res.status(200).json({ 
        reply: fallbackMessage, 
        nextAction: classification,
        debug: {
          queryTokens: queryTokens.slice(0, 5),
          topBlocks: ranked.map(b => ({ title: b.title, score: 'N/A' }))
        }
      });
    }

    const data = await r.json();
    const reply = (data.choices?.[0]?.message?.content || '').trim();
    
    if (!reply) {
      const defaultReply = `Bonjour. Problème de FAP détecté. Notre nettoyage haute pression restaure les performances pour 99€ minimum. Avez-vous un voyant FAP allumé ?`;
      
      return res.status(200).json({ 
        reply: defaultReply, 
        nextAction: classification,
        debug: {
          queryTokens: queryTokens.slice(0, 5),
          topBlocks: ranked.map(b => ({ title: b.title, score: 'N/A' }))
        }
      });
    }

    const response = { 
      reply, 
      nextAction: classification,
      debug: process.env.NODE_ENV === 'development' ? {
        queryTokens: queryTokens.slice(0, 10),
        topBlocks: ranked.map(b => ({ title: b.title, priority: b.priority })),
        classification: classification,
        cached: false
      } : undefined
    };

    // Mise en cache de la réponse
    setCachedResponse(cacheKey, response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('Erreur API:', error);
    
    const backupMessage = `Problème de FAP détecté. Notre service est disponible partout en France. Avez-vous un voyant FAP allumé ?`;
    
    return res.status(200).json({ 
      reply: backupMessage, 
      nextAction: classification,
      debug: {
        error: 'API Error',
        queryTokens: queryTokens.slice(0, 5)
      }
    });
  }
}
