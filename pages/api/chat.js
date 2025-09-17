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
  'le','la','les','de','des','du','un','une','et','ou','au','aux','en','à','a','d\'','l\'',
  'pour','avec','sur','est','c\'est','il','elle','on','tu','te','ton','ta','tes','vos','votre',
  'mes','mon','ma','mais','plus','moins','que','qui','dans','ce','cet','cette','ses','son','leurs',
  'avoir','être','faire','aller','dire','venir','voir','savoir','prendre','vouloir','pouvoir',
  'bonjour','salut','merci','svp','voilà','donc','alors','comme','très','tout','tous','toute',
  'oui','non','peut','peux','bien','mal','comment','quand','où','pourquoi','combien'
]);

// ============ SYNONYMES AUTOMOBILES ÉTENDUS ============
const AUTOMOTIVE_SYNONYMS = {
  'fap': ['filtre', 'particule', 'particules', 'dpf', 'diesel'],
  'filtre': ['fap', 'dpf', 'filtration', 'filtrer'],
  'particule': ['particules', 'suie', 'carbone', 'pollution'],
  'encrassé': ['saturé', 'colmaté', 'bouché', 'obstrué', 'sale'],
  'saturé': ['encrassé', 'plein', 'colmaté', 'bouché'],
  'voyant': ['témoin', 'lampe', 'indicateur', 'signal', 'alerte'],
  'perte': ['baisse', 'diminution', 'réduction', 'faible'],
  'puissance': ['force', 'performance', 'accélération', 'reprises'],
  'fumée': ['fumées', 'échappement', 'vapeur', 'émission'],
  'nettoyage': ['lavage', 'décrassage', 'maintenance', 'entretien'],
  'diagnostic': ['diag', 'contrôle', 'vérification', 'analyse'],
  'garage': ['atelier', 'mécanicien', 'réparation', 'service']
};

// ============ FONCTIONS UTILITAIRES ============
function normalize(s = '') {
  return s.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}+/gu, '')
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function frenchStem(word) {
  const endings = ['ment', 'tion', 'sion', 'ance', 'ence', 'able', 'ible', 'eur', 'euse', 'ant', 'ent'];
  
  for (const ending of endings) {
    if (word.length > ending.length + 2 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  
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

// ============ SCORING SIMPLE MAIS EFFICACE ============
function scoreBlockSimple(block, queryTokens) {
  const blockTokens = tokenize(block.title + ' ' + block.body + ' ' + (block.synonyms || []).join(' '));
  
  let score = 0;
  for (const queryToken of queryTokens) {
    if (blockTokens.includes(queryToken)) {
      score += 1;
    }
  }
  
  // Bonus titre
  const titleTokens = tokenize(block.title);
  const titleMatches = queryTokens.filter(qt => titleTokens.includes(qt)).length;
  score += titleMatches * 1.5;
  
  // Bonus synonymes
  const synTokens = tokenize((block.synonyms || []).join(' '));
  const synMatches = queryTokens.filter(qt => synTokens.includes(qt)).length;
  score += synMatches * 1.2;
  
  return score + (block.priority || 5) * 0.1;
}

// ============ CLASSIFICATION ============
function classifyAdvanced(text) {
  const txt = normalize(text);
  
  // Vraie urgence
  if (/surchauffe|voyant.*rouge.*moteur/i.test(txt)) {
    return { type: 'URGENCE_REELLE', confidence: 10 };
  }
  
  // Symptômes FAP
  const symptoms = [];
  if (/voyant.*clignotant|clignotant.*voyant|clignote/i.test(txt)) symptoms.push('clignotant');
  if (/voyant|témoin/i.test(txt)) symptoms.push('voyant');
  if (/perte.*puissance|baisse.*puissance/i.test(txt)) symptoms.push('puissance');
  if (/fumée.*noire/i.test(txt)) symptoms.push('fumee');
  if (/saturé|encrassé|colmaté/i.test(txt)) symptoms.push('sature');
  
  if (symptoms.includes('clignotant')) {
    return { type: 'FAP_CLIGNOTANT', confidence: 9, symptoms };
  }
  
  if (symptoms.length >= 2) {
    return { type: 'FAP_MULTI', confidence: 8, symptoms };
  }
  
  if (symptoms.length === 1 || /\b(fap|dpf)\b/i.test(txt)) {
    return { type: 'FAP_SINGLE', confidence: 6, symptoms };
  }
  
  return { type: 'GEN', confidence: 0, symptoms: [] };
}

function isFirstInteraction(historique) {
  if (!historique) return true;
  const hist = normalize(historique);
  // Si l'historique ne contient pas de réponse du bot, c'est une première interaction
  return hist.length < 30 || !hist.includes('autoai') && !hist.includes('assistant');
}

// ============ PARSING ============
function parseBlocks(raw) {
  const parts = raw.split(/\n(?=\[[^\]]*\]\s*)/g);
  return parts.map(p => {
    const m = p.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
    if (!m) return null;
    
    const title = m[1] || '';
    const body = (m[2] || '').trim();
    
    const synLine = body.match(/^Synonymes:\s*(.+)$/mi);
    const synonyms = synLine ? 
      synLine[1].split(/[,|]/).map(s => s.trim()).filter(Boolean) : [];
    
    const priority = title.includes('EMPATHIQUE') ? 9 :
                    title.includes('CLIGNOTANT') ? 9 :
                    title.includes('FAP') ? 8 :
                    title.includes('SYMPTÔMES') ? 7 : 5;
    
    return { 
      title, 
      body: body.replace(/^(Synonymes|Mots-clés):\s*.+$/gmi, '').trim(), 
      synonyms,
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

  // Chargement des données
  let raw;
  try {
    raw = fs.readFileSync(path.join(process.cwd(), 'data', 'data.txt'), 'utf-8');
  } catch {
    return res.status(500).json({ error: 'Erreur de lecture des données' });
  }

  const blocks = parseBlocks(raw);
  const queryTokens = tokenize(historique + ' ' + question);
  
  const ranked = blocks
    .map(b => ({ b, s: scoreBlockSimple(b, queryTokens) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(x => x.b);

  const contextText = ranked.length
    ? ranked.map(b => '[' + b.title + ']\n' + b.body).join('\n\n')
    : "Utilise tes connaissances sur les FAP.";

  const classification = classifyAdvanced(question);
  const isFirst = isFirstInteraction(historique);

  // Construction du prompt - VERSION SIMPLE MAIS STRICTE
  let systemPrompt = 'Tu es l\'assistant Re-Fap, expert en nettoyage de filtres à particules.\n\n';
  
  if (isFirst) {
    systemPrompt += 'PREMIÈRE INTERACTION - MODE EMPATHIQUE OBLIGATOIRE :\n' +
      '- Commencer par "Bonjour ! Je comprends votre inquiétude..."\n' +
      '- Rassurer le client\n' +
      '- Expliquer brièvement ce qu\'est un FAP et pourquoi il s\'encrasse\n' +
      '- Mentionner que c\'est résoluble\n' +
      '- 100 mots maximum\n' +
      '- Finir par UNE question sur les symptômes\n\n';
  } else {
    systemPrompt += 'SUITE DE CONVERSATION - MODE CONCIS :\n' +
      '- 80 mots maximum strictement\n' +
      '- Aller directement à la solution\n\n';
  }
  
  systemPrompt += 'DÉLAIS RÉELS OBLIGATOIRES :\n' +
    '- Carter-Cash équipé : 4 heures, 99-149€\n' +
    '- Carter-Cash non équipé : 48 heures, 199€ port compris\n' +
    '- Garage partenaire : 48 heures, 99-149€ + main d\'œuvre\n\n' +
    'LOGIQUE :\n' +
    '1. VOYANT CLIGNOTANT : Mode dégradé, évitez longs trajets, question démontage\n' +
    '2. SYMPTÔMES MULTIPLES : FAP saturé, question démontage directe\n' +
    '3. CLIENT NE PEUT PAS : "Garage partenaire : démontage, nettoyage, remontage en 48h pour 99-149€ + main d\'œuvre. Cliquez sur Trouver un garage partenaire."\n' +
    '4. CLIENT PEUT : "Carter-Cash équipé 4h (99-149€) ou autres 48h (199€). Cliquez sur Trouver un Carter-Cash."\n\n' +
    'INTERDICTIONS STRICTES :\n' +
    '- Jamais d\'astérisques ou abréviations\n' +
    '- Jamais inventer délais\n' +
    '- Pas d\'emojis, pas de listes à puces\n' +
    '- Format naturel en paragraphes';

  const system = systemPrompt;

  const userContent = 'Historique: ' + (historique || '(Première interaction)') + '\n' +
    'Question: ' + question + '\n' +
    'Classification: ' + classification.type + '\n' +
    'Première interaction: ' + isFirst + '\n\n' +
    'Contexte: ' + contextText;

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.MISTRAL_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        temperature: isFirst ? 0.3 : 0.1,
        top_p: 0.6,
        max_tokens: isFirst ? 200 : 120,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ]
      })
    });

    if (!r.ok) {
      const fallbackMessage = isFirst 
        ? "Bonjour ! Je comprends votre inquiétude. Un FAP capture les particules diesel et s'encrasse avec le temps. Notre nettoyage évite le remplacement coûteux. Quel symptôme observez-vous exactement ?"
        : "Problème de FAP détecté. Quel symptôme observez-vous : voyant allumé, perte de puissance ou fumée noire ?";
      
      return res.status(200).json({ 
        reply: fallbackMessage, 
        nextAction: classification
      });
    }

    const data = await r.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    
    if (!reply) {
      const defaultReply = isFirst
        ? "Bonjour ! Je vois que vous avez un souci avec votre véhicule. Décrivez-moi ce qui vous préoccupe."
        : "Problème détecté. Décrivez vos symptômes.";
      
      return res.status(200).json({ 
        reply: defaultReply, 
        nextAction: classification
      });
    }

    const response = { 
      reply, 
      nextAction: classification,
      debug: process.env.NODE_ENV === 'development' ? {
        queryTokens: queryTokens.slice(0, 5),
        topBlocks: ranked.map(b => ({ title: b.title })),
        classification: classification,
        isFirstInteraction: isFirst
      } : undefined
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Erreur API:', error);
    
    const backupMessage = isFirst
      ? "Bonjour ! Problème technique temporaire. Décrivez-moi vos symptômes de FAP."
      : "Problème technique temporaire. Décrivez vos symptômes FAP.";
    
    return res.status(200).json({ 
      reply: backupMessage, 
      nextAction: classification
    });
  }
}
