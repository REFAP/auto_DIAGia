// pages/api/chat.js
import fs from 'fs';
import path from 'path';

// ============ CONFIGURATION ============
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000;
let dataCache = null;
let blocksCache = null;
let queryCache = new Map();

// ============ RÉPONSES EMPATHIQUES PRÉ-ÉCRITES ============
const EMPATHETIC_RESPONSES = {
  'voyant_fap': "Bonjour ! Je comprends votre inquiétude concernant ce voyant FAP qui s'allume. C'est effectivement préoccupant mais rassurez-vous, c'est un problème fréquent et généralement résoluble. Le FAP (filtre à particules) capture les particules polluantes de votre moteur diesel. Avec le temps, il s'encrasse progressivement, d'où ce signal d'alerte. La bonne nouvelle c'est qu'un nettoyage professionnel évite le remplacement coûteux. Pour vous orienter vers la meilleure solution, avez-vous aussi remarqué une perte de puissance ou une fumée noire à l'échappement ?",
  
  'dpf_sature': "Bonjour ! Je vois que vous avez détecté un problème de DPF (filtre à particules) saturé. C'est un souci classique sur les diesels modernes, mais pas de panique ! Ce filtre capture les suies pour protéger l'environnement, mais il finit par se colmater. Heureusement, notre nettoyage haute pression restaure ses performances pour seulement 99€ minimum, bien moins cher qu'un remplacement. Pour vous proposer la solution la plus adaptée, pouvez-vous me dire si vous observez d'autres symptômes comme une perte de puissance ?",
  
  'perte_puissance': "Bonjour ! Cette perte de puissance que vous ressentez est effectivement frustrante au quotidien. Sur les véhicules diesel, c'est souvent lié à un filtre à particules encrassé qui empêche le moteur de respirer correctement. Imaginez un aspirateur avec un sac plein - c'est exactement ce qui arrive à votre moteur ! Notre nettoyage haute pression peut résoudre ce problème rapidement et économiquement. Avez-vous aussi un voyant FAP allumé ou remarqué une fumée noire à l'échappement ?",
  
  'fumee_noire': "Bonjour ! Cette fumée noire que vous observez est inquiétante, je comprends. C'est généralement le signe que votre FAP (filtre à particules) ne peut plus retenir les suies correctement car il est saturé. Votre moteur rejette alors directement les particules. La solution reste simple : un nettoyage professionnel redonne au filtre toute son efficacité. Pour confirmer le diagnostic, avez-vous également une perte de puissance ou un voyant moteur allumé ?",
  
  'general': "Bonjour ! Je suis là pour vous aider avec votre problème de FAP. Les filtres à particules sont essentiels mais peuvent s'encrasser avec le temps, surtout en conduite urbaine. La bonne nouvelle, c'est qu'un nettoyage professionnel évite le remplacement coûteux et restaure les performances. Pour vous orienter au mieux, pouvez-vous me décrire les symptômes que vous observez : voyant allumé, perte de puissance, ou fumée noire ?"
};

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

// ============ DÉTECTION PREMIÈRE INTERACTION ============
function isFirstInteraction(historique) {
  if (!historique || historique.length < 50) return true;
  
  // Si l'historique ne contient pas de réponse du bot, c'est une première interaction
  const hist = normalize(historique);
  return !hist.includes('re-fap') && !hist.includes('carter-cash') && !hist.includes('garage partenaire') && !hist.includes('démontage');
}

// ============ SÉLECTION RÉPONSE EMPATHIQUE ============
function getEmpatheticResponse(question) {
  const q = normalize(question);
  
  if (/voyant|témoin|allume|clignot/i.test(q)) {
    return EMPATHETIC_RESPONSES['voyant_fap'];
  }
  
  if (/dpf|satur|encras|colmat/i.test(q)) {
    return EMPATHETIC_RESPONSES['dpf_sature'];
  }
  
  if (/perte|puissance|baisse|faible|accélérat/i.test(q)) {
    return EMPATHETIC_RESPONSES['perte_puissance'];
  }
  
  if (/fumée|noir|échappement/i.test(q)) {
    return EMPATHETIC_RESPONSES['fumee_noire'];
  }
  
  return EMPATHETIC_RESPONSES['general'];
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

  // Détection première interaction
  const isFirst = isFirstInteraction(historique);
  
  // Si première interaction, utiliser la réponse empathique pré-écrite
  if (isFirst) {
    const empatheticReply = getEmpatheticResponse(question);
    return res.status(200).json({ 
      reply: empatheticReply, 
      nextAction: { type: 'FIRST_INTERACTION', confidence: 10 }
    });
  }

  // Pour les interactions suivantes, continuer avec l'API
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

  // Construction du prompt pour interactions suivantes
  const system = `Tu es l'assistant Re-Fap, expert en nettoyage de filtres à particules.

SUITE DE CONVERSATION - MODE CONCIS :
- 80 mots maximum strictement
- Réponse directe et professionnelle
- Aller rapidement à la solution

DÉLAIS RÉELS OBLIGATOIRES :
- Carter-Cash équipé : 4 heures, 99-149€
- Carter-Cash non équipé : 48 heures, 199€ port compris
- Garage partenaire : 48 heures, 99-149€ + main d'œuvre

LOGIQUE :
1. VOYANT CLIGNOTANT : "Voyant clignotant confirme un FAP saturé. Mode dégradé, évitez les longs trajets. Pouvez-vous démonter le FAP vous-même ?"
2. SYMPTÔMES MULTIPLES : "FAP saturé confirmé. Pouvez-vous le démonter vous-même ?"
3. CLIENT NE PEUT PAS : "Garage partenaire : démontage, nettoyage, remontage en 48h pour 99-149€ + main d'œuvre. Cliquez sur Trouver un garage partenaire."
4. CLIENT PEUT : "Carter-Cash équipé 4h (99-149€) ou autres 48h (199€). Cliquez sur Trouver un Carter-Cash."

INTERDICTIONS STRICTES :
- Jamais inventer de délais
- Jamais d'emojis ou listes
- Format paragraphe naturel`;

  const userContent = 'Historique: ' + historique + '\n' +
    'Question: ' + question + '\n' +
    'Classification: ' + classification.type + '\n\n' +
    'Contexte: ' + contextText + '\n\n' +
    'RAPPEL : Maximum 80 mots, aller directement à la solution.';

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.MISTRAL_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        temperature: 0.1,
        top_p: 0.6,
        max_tokens: 120,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ]
      })
    });

    if (!r.ok) {
      const fallbackMessage = "Problème de FAP détecté. Pouvez-vous démonter le filtre vous-même ? Si oui : Carter-Cash équipé 4h ou autres 48h. Sinon : garage partenaire 48h avec main d'œuvre.";
      
      return res.status(200).json({ 
        reply: fallbackMessage, 
        nextAction: classification
      });
    }

    const data = await r.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    
    if (!reply) {
      const defaultReply = "FAP saturé confirmé. Pouvez-vous démonter le filtre vous-même ?";
      
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
        classification: classification
      } : undefined
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Erreur API:', error);
    
    const backupMessage = "Problème FAP détecté. Pouvez-vous démonter le filtre ?";
    
    return res.status(200).json({ 
      reply: backupMessage, 
      nextAction: classification
    });
  }
}
