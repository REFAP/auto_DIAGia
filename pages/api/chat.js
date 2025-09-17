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
    'eur', 'euse', 'ant', 'ent', 'age', 'aire', 'aux', 'eau', 'eaux'
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

// ============ CLASSIFICATION TECHNIQUE PRÉCISE ============
function classifyAdvanced(text) {
  const txt = normalize(text);
  const tokens = tokenize(txt);
  
  // Vraies urgences (rares)
  if (/surchauffe|voyant.*rouge.*moteur|fumée.*blanche.*épaisse|perte.*totale.*puissance/i.test(txt)) {
    return { type: 'URGENCE_REELLE', confidence: 10, priority: 'CRITICAL', symptoms: ['urgence'] };
  }
  
  // Comptage des symptômes FAP
  const fapSymptoms = [];
  
  if (/voyant.*fap|fap.*voyant|témoin.*fap/i.test(txt)) fapSymptoms.push('voyant');
  if (/voyant.*clignotant|clignotant.*voyant|voyant.*clignote|clignote/i.test(txt)) fapSymptoms.push('clignotant');
  if (/perte.*puissance|baisse.*puissance|puissance.*faible|moins.*puissant/i.test(txt)) fapSymptoms.push('puissance');
  if (/fumée.*noire|fumées.*noires|échappement.*noir/i.test(txt)) fapSymptoms.push('fumee');
  if (/saturé|encrassé|colmaté|bouché|obstrué/i.test(txt)) fapSymptoms.push('sature');
  if (/surconsommation|consomme.*plus/i.test(txt)) fapSymptoms.push('conso');
  if (/odeur.*âcre|odeur.*forte/i.test(txt)) fapSymptoms.push('odeur');
  if (/régime.*instable|moteur.*instable/i.test(txt)) fapSymptoms.push('instable');
  
  const symptomCount = fapSymptoms.length;
  
  // Classification selon les symptômes
  if (fapSymptoms.includes('clignotant')) {
    return { 
      type: 'FAP_CLIGNOTANT', 
      confidence: 9, 
      priority: 'HIGH', 
      symptoms: fapSymptoms,
      symptomCount 
    };
  }
  
  if (symptomCount >= 2) {
    return { 
      type: 'FAP_MULTI', 
      confidence: 8, 
      priority: 'HIGH', 
      symptoms: fapSymptoms,
      symptomCount 
    };
  }
  
  if (symptomCount === 1 || /\b(fap|dpf)\b|filtre.*particule/i.test(txt)) {
    return { 
      type: 'FAP_SINGLE', 
      confidence: 6, 
      priority: 'MEDIUM', 
      symptoms: fapSymptoms,
      symptomCount 
    };
  }
  
  // Autres problèmes
  if (/\begr\b|vanne.*egr|recirculation.*gaz/i.test(txt)) {
    return { type: 'EGR', confidence: 4, priority: 'LOW', symptoms: [], symptomCount: 0 };
  }
  
  if (/\badblue\b|niveau.*adblue|def\b/i.test(txt)) {
    return { type: 'ADBLUE', confidence: 3, priority: 'LOW', symptoms: [], symptomCount: 0 };
  }
  
  if (/diagnostic|contrôle|garage|rdv/i.test(txt)) {
    return { type: 'DIAG', confidence: 2, priority: 'LOW', symptoms: [], symptomCount: 0 };
  }
  
  return { type: 'GEN', confidence: 0, priority: 'LOW', symptoms: [], symptomCount: 0 };
}

// ============ DÉTECTION PREMIÈRE INTERACTION ============
function isFirstInteraction(historique) {
  if (!historique) return true;
  const hist = normalize(historique);
  return hist.length < 50 || !hist.includes('autoai:');
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
    const priority = title.includes('URGENCE') ? 10 :
                    title.includes('EMPATHIQUE') ? 9 :
                    title.includes('CLIGNOTANT') ? 9 :
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

  // Classification avancée et détection première interaction
  const classification = classifyAdvanced(question);
  const isFirst = isFirstInteraction(historique);

  // Prompt système adaptatif selon le contexte
  const system = `
Tu es l'assistant Re-Fap, expert en nettoyage de filtres à particules (FAP).

[CONTEXTE: ${classification.type} | Confiance: ${classification.confidence} | Première interaction: ${isFirst}]
[SYMPTÔMES DÉTECTÉS: ${classification.symptoms?.join(', ') || 'aucun'} (${classification.symptomCount || 0})]

MODE DE RÉPONSE:
${isFirst ? 'EMPATHIQUE & PÉDAGOGIQUE - Première interaction' : 'CONCIS & DIRECT - Suite de conversation'}

LOGIQUE TECHNIQUE PRÉCISE:

1. VRAIE URGENCE (très rare):
   Surchauffe moteur + voyant rouge moteur → "ARRÊT IMMÉDIAT nécessaire"

2. VOYANT FAP CLIGNOTANT:
   "Voyant clignotant confirme un FAP saturé. Votre véhicule fonctionne en mode dégradé avec perte de puissance. Évitez les longs trajets. Pouvez-vous démonter le FAP vous-même ?"

3. SYMPTÔMES MULTIPLES (2+ symptômes FAP):
   "Vos symptômes confirment un FAP saturé. Pouvez-vous le démonter vous-même ?"

4. SYMPTÔME UNIQUE FAP:
   Une question pour confirmer, puis solution

5. VOYANT FAP FIXE SEUL:
   "Voyant fixe indique un début d'encrassement. Avez-vous aussi une perte de puissance ?"

TONE:
${isFirst ? 
`EMPATHIQUE: Rassurez le client, expliquez simplement le problème, montrez la compréhension.
PÉDAGOGIQUE: Expliquez brièvement ce qu'est un FAP et pourquoi il s'encrasse.` :
`CONCIS: Réponses courtes et directes.
PRATIQUE: Allez droit au but vers la solution.`}

SOLUTIONS FINALES:
- Peut démonter: "Carter-Cash équipé nettoie en 4h (99-149€) ou autres en 48h (199€ port compris). Cliquez sur Trouver un Carter-Cash."
- Ne peut pas: "Garage partenaire pour diagnostic complet et nettoyage (99-149€ + main d'œuvre). Cliquez sur Trouver un garage partenaire."
- Non-FAP: "Diagnostic par garage partenaire recommandé. Cliquez sur Trouver un garage partenaire."

RÈGLES:
- Maximum 80 mots (sauf première interaction empathique: 100 mots max)
- Pas d'emojis, pas de listes à puces
- Maximum 2 questions avant solution
- Fin après solution donnée
`;

  const userContent = `
Historique: ${historique || '(Première interaction)'}
Question: ${question}
Classification: ${classification.type}
Symptômes détectés: ${classification.symptoms?.join(', ') || 'aucun'}
Première interaction: ${isFirst}

Contexte technique: ${contextText}

ANALYSE:
- Si première interaction ET symptômes FAP détectés → réponse empathique et pédagogique
- Si suite de conversation → réponse concise et directe
- Voyant clignotant = mode dégradé, pas urgence d'arrêt
- Symptômes multiples → solution directe
- Fin de conversation sur "merci/ok" → "Avec plaisir. Bonne journée !"
`;

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        temperature: isFirst ? 0.3 : 0.1,  // Plus de variabilité pour l'empathie
        top_p: isFirst ? 0.8 : 0.6,
        max_tokens: isFirst ? 250 : 150,    // Plus de place pour l'empathie
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ]
      })
    });

    if (!r.ok) {
      const fallbackMessage = isFirst 
        ? `Bonjour ! Je comprends votre inquiétude concernant votre véhicule. Un FAP (filtre à particules) est une pièce qui capture les particules des moteurs diesel. Quand il s'encrasse, cela cause les symptômes que vous décrivez. Heureusement, nous proposons un nettoyage efficace qui évite le remplacement coûteux. Quel symptôme observez-vous exactement ?`
        : `Problème de FAP détecté. Quel symptôme observez-vous : voyant allumé, perte de puissance ou fumée noire ?`;
      
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
      const defaultReply = isFirst
        ? `Bonjour ! Je vois que vous avez un souci avec votre véhicule. Décrivez-moi ce qui vous préoccupe et je vous aiderai à identifier s'il s'agit d'un problème de FAP.`
        : `Problème détecté. Décrivez vos symptômes pour que je puisse vous orienter.`;
      
      return res.status(200).json({ 
        reply: defaultReply, 
        nextAction: classification,
        debug: {
          queryTokens: queryTokens.slice(0, 5),
          isFirst: isFirst
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
        isFirstInteraction: isFirst,
        cached: false
      } : undefined
    };

    // Mise en cache de la réponse
    setCachedResponse(cacheKey, response);

    return res.status(200).json(response);

  } catch (error) {
    console.error('Erreur API:', error);
    
    const backupMessage = isFirst
      ? `Bonjour ! Notre système rencontre une difficulté technique temporaire. Cependant, je peux déjà vous dire que la plupart des problèmes de moteur diesel sont liés au FAP. Décrivez-moi vos symptômes.`
      : `Problème technique temporaire. Décrivez vos symptômes FAP.`;
    
    return res.status(200).json({ 
      reply: backupMessage, 
      nextAction: classification,
      debug: {
        error: 'API Error',
        isFirst: isFirst
      }
    });
  }
}
