/**
 * Curated emoji catalogue for expenses, with French keywords and a small fuzzy
 * search. The emoji is user content (a category marker on a depense), not UI
 * iconography, so it syncs like any other expense field.
 */
export interface EmojiEntry {
  emoji: string
  keywords: string[]
}

/** Lowercase + strip accents so "électricité" matches "electricite". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// Keywords are stored unaccented (normalize() is applied to queries too).
export const EXPENSE_EMOJIS: EmojiEntry[] = [
  // Logement
  { emoji: '🏠', keywords: ['maison', 'loyer', 'logement', 'domicile'] },
  { emoji: '🏢', keywords: ['appartement', 'appart', 'immeuble', 'studio'] },
  { emoji: '🏡', keywords: ['jardin', 'maison de campagne', 'gite'] },
  { emoji: '🛋️', keywords: ['meuble', 'canape', 'salon', 'deco', 'decoration', 'ikea'] },
  { emoji: '🛏️', keywords: ['lit', 'chambre', 'matelas', 'literie'] },
  { emoji: '🔑', keywords: ['cle', 'caution', 'agence', 'bail'] },
  { emoji: '🧹', keywords: ['menage', 'nettoyage', 'balai', 'produits menagers'] },
  { emoji: '🧺', keywords: ['laverie', 'lessive', 'linge', 'pressing'] },
  { emoji: '🛠️', keywords: ['bricolage', 'outils', 'travaux', 'reparation', 'brico'] },
  { emoji: '🎨', keywords: ['peinture', 'art', 'dessin', 'atelier'] },
  { emoji: '🪴', keywords: ['plante', 'fleur', 'jardinage', 'jardinerie'] },

  // Factures et services
  { emoji: '⚡', keywords: ['electricite', 'edf', 'courant', 'energie'] },
  { emoji: '💧', keywords: ['eau', 'facture eau'] },
  { emoji: '🔥', keywords: ['gaz', 'chauffage', 'feu', 'barbecue', 'bbq'] },
  { emoji: '📶', keywords: ['internet', 'wifi', 'box', 'fibre'] },
  { emoji: '📱', keywords: ['telephone', 'portable', 'forfait', 'mobile'] },
  { emoji: '📺', keywords: ['television', 'tv', 'netflix', 'streaming', 'abonnement'] },
  { emoji: '🎵', keywords: ['musique', 'spotify', 'deezer', 'concert'] },
  { emoji: '🧾', keywords: ['facture', 'impots', 'taxe', 'administratif'] },
  { emoji: '🛡️', keywords: ['assurance', 'mutuelle', 'protection'] },
  { emoji: '🏦', keywords: ['banque', 'frais bancaires', 'credit', 'pret'] },
  { emoji: '💶', keywords: ['especes', 'cash', 'argent', 'liquide', 'retrait'] },
  { emoji: '💳', keywords: ['carte', 'cb', 'paiement'] },

  // Courses et nourriture
  { emoji: '🛒', keywords: ['courses', 'supermarche', 'carrefour', 'leclerc', 'lidl', 'auchan', 'intermarche', 'caddie'] },
  { emoji: '🥖', keywords: ['boulangerie', 'pain', 'baguette', 'viennoiserie'] },
  { emoji: '🥐', keywords: ['croissant', 'petit dejeuner', 'brunch'] },
  { emoji: '🧀', keywords: ['fromage', 'fromagerie'] },
  { emoji: '🥩', keywords: ['viande', 'boucherie', 'boucher'] },
  { emoji: '🐟', keywords: ['poisson', 'poissonnerie', 'peche'] },
  { emoji: '🥬', keywords: ['legumes', 'primeur', 'marche', 'bio'] },
  { emoji: '🍎', keywords: ['fruits', 'pomme', 'verger'] },
  { emoji: '🍽️', keywords: ['restaurant', 'resto', 'diner', 'dejeuner', 'repas'] },
  { emoji: '🍕', keywords: ['pizza', 'pizzeria', 'italien'] },
  { emoji: '🍔', keywords: ['burger', 'fast food', 'mcdo', 'mcdonalds', 'quick'] },
  { emoji: '🌮', keywords: ['tacos', 'mexicain', 'kebab'] },
  { emoji: '🍣', keywords: ['sushi', 'japonais', 'asiatique'] },
  { emoji: '🍜', keywords: ['ramen', 'nouilles', 'chinois', 'pho'] },
  { emoji: '🥗', keywords: ['salade', 'healthy', 'vegetarien'] },
  { emoji: '🍦', keywords: ['glace', 'glacier', 'dessert'] },
  { emoji: '🎂', keywords: ['gateau', 'anniversaire', 'patisserie'] },
  { emoji: '🍫', keywords: ['chocolat', 'bonbon', 'sucreries', 'snack'] },
  { emoji: '🍿', keywords: ['popcorn', 'snacks', 'aperitif'] },
  { emoji: '☕', keywords: ['cafe', 'the', 'expresso', 'starbucks'] },
  { emoji: '🍺', keywords: ['biere', 'bar', 'pinte', 'pub', 'brasserie'] },
  { emoji: '🍷', keywords: ['vin', 'cave', 'rouge', 'blanc', 'rose'] },
  { emoji: '🍾', keywords: ['champagne', 'fete', 'celebration', 'bouteille'] },
  { emoji: '🍹', keywords: ['cocktail', 'mojito', 'apero', 'soiree'] },
  { emoji: '🥤', keywords: ['soda', 'boisson', 'coca', 'jus'] },

  // Transport
  { emoji: '⛽', keywords: ['essence', 'carburant', 'gasoil', 'diesel', 'station'] },
  { emoji: '🚗', keywords: ['voiture', 'auto', 'covoiturage', 'blablacar', 'location voiture'] },
  { emoji: '🅿️', keywords: ['parking', 'stationnement', 'horodateur'] },
  { emoji: '🛣️', keywords: ['peage', 'autoroute', 'route'] },
  { emoji: '🚕', keywords: ['taxi', 'uber', 'vtc', 'bolt'] },
  { emoji: '🚌', keywords: ['bus', 'car', 'navette', 'flixbus'] },
  { emoji: '🚆', keywords: ['train', 'sncf', 'tgv', 'ter', 'gare'] },
  { emoji: '🚇', keywords: ['metro', 'tram', 'ticket', 'navigo', 'transport'] },
  { emoji: '✈️', keywords: ['avion', 'vol', 'aeroport', 'billet avion'] },
  { emoji: '⛴️', keywords: ['bateau', 'ferry', 'croisiere', 'traversee'] },
  { emoji: '🚲', keywords: ['velo', 'velib', 'cyclisme', 'vtt'] },
  { emoji: '🛵', keywords: ['scooter', 'moto', 'trottinette', 'lime'] },
  { emoji: '🔧', keywords: ['garagiste', 'garage', 'revision', 'mecanique', 'pneu'] },

  // Voyage et vacances
  { emoji: '🏨', keywords: ['hotel', 'airbnb', 'hebergement', 'auberge', 'booking'] },
  { emoji: '🏕️', keywords: ['camping', 'tente', 'bivouac', 'randonnee'] },
  { emoji: '🏖️', keywords: ['plage', 'vacances', 'mer', 'ete', 'parasol'] },
  { emoji: '⛰️', keywords: ['montagne', 'rando', 'alpes', 'refuge'] },
  { emoji: '🎿', keywords: ['ski', 'forfait ski', 'snowboard', 'station ski', 'hiver'] },
  { emoji: '🧳', keywords: ['voyage', 'valise', 'bagage', 'week-end', 'weekend', 'trip'] },
  { emoji: '🗺️', keywords: ['excursion', 'visite', 'tourisme', 'carte'] },
  { emoji: '🏛️', keywords: ['musee', 'monument', 'culture', 'expo', 'exposition'] },
  { emoji: '🎡', keywords: ['parc attraction', 'fete foraine', 'disneyland', 'manege'] },
  { emoji: '🛂', keywords: ['visa', 'passeport', 'douane'] },

  // Sorties et loisirs
  { emoji: '🎬', keywords: ['cinema', 'cine', 'film', 'seance'] },
  { emoji: '🎭', keywords: ['theatre', 'spectacle', 'comedie', 'opera'] },
  { emoji: '🎫', keywords: ['billet', 'ticket', 'entree', 'place', 'reservation'] },
  { emoji: '🎤', keywords: ['karaoke', 'concert', 'festival', 'chant'] },
  { emoji: '🪩', keywords: ['boite', 'club', 'discotheque', 'danse', 'nuit'] },
  { emoji: '🎮', keywords: ['jeux video', 'gaming', 'console', 'playstation', 'switch'] },
  { emoji: '🎲', keywords: ['jeux', 'jeu de societe', 'casino', 'poker'] },
  { emoji: '🎳', keywords: ['bowling', 'billard'] },
  { emoji: '⚽', keywords: ['foot', 'football', 'match', 'stade'] },
  { emoji: '🏀', keywords: ['basket', 'basketball'] },
  { emoji: '🎾', keywords: ['tennis', 'padel', 'badminton', 'squash'] },
  { emoji: '🏊', keywords: ['piscine', 'natation', 'nage'] },
  { emoji: '🏋️', keywords: ['sport', 'salle de sport', 'musculation', 'fitness', 'gym', 'basic fit'] },
  { emoji: '🧗', keywords: ['escalade', 'grimpe', 'bloc'] },
  { emoji: '⛳', keywords: ['golf', 'minigolf'] },
  { emoji: '🎣', keywords: ['peche', 'canne'] },
  { emoji: '📚', keywords: ['livre', 'librairie', 'lecture', 'bd', 'manga'] },
  { emoji: '📰', keywords: ['journal', 'magazine', 'presse'] },

  // Sante et soins
  { emoji: '💊', keywords: ['pharmacie', 'medicament', 'ordonnance'] },
  { emoji: '🏥', keywords: ['medecin', 'docteur', 'hopital', 'sante', 'consultation'] },
  { emoji: '🦷', keywords: ['dentiste', 'dent', 'orthodontie'] },
  { emoji: '👓', keywords: ['opticien', 'lunettes', 'lentilles', 'ophtalmo'] },
  { emoji: '💆', keywords: ['massage', 'spa', 'bien-etre', 'osteo', 'kine'] },
  { emoji: '💇', keywords: ['coiffeur', 'coiffure', 'barbier', 'cheveux'] },
  { emoji: '💅', keywords: ['manucure', 'ongles', 'esthetique', 'beaute'] },
  { emoji: '🧴', keywords: ['cosmetique', 'creme', 'parfum', 'hygiene', 'sephora'] },

  // Shopping
  { emoji: '👕', keywords: ['vetements', 'habits', 'tshirt', 'fringues', 'zara', 'shopping'] },
  { emoji: '👟', keywords: ['chaussures', 'baskets', 'sneakers', 'nike'] },
  { emoji: '👗', keywords: ['robe', 'mode', 'boutique'] },
  { emoji: '🧥', keywords: ['manteau', 'veste', 'blouson'] },
  { emoji: '👜', keywords: ['sac', 'maroquinerie', 'accessoire'] },
  { emoji: '💍', keywords: ['bijou', 'bague', 'bijouterie', 'or'] },
  { emoji: '⌚', keywords: ['montre', 'horlogerie'] },
  { emoji: '🕶️', keywords: ['lunettes de soleil', 'solaires'] },
  { emoji: '🖥️', keywords: ['ordinateur', 'pc', 'informatique', 'ecran', 'mac'] },
  { emoji: '🎧', keywords: ['casque', 'ecouteurs', 'audio', 'airpods'] },
  { emoji: '📷', keywords: ['photo', 'appareil photo', 'camera'] },
  { emoji: '🔌', keywords: ['electronique', 'chargeur', 'cable', 'fnac', 'darty'] },
  { emoji: '📦', keywords: ['colis', 'amazon', 'livraison', 'commande', 'internet achat'] },

  // Famille et animaux
  { emoji: '👶', keywords: ['bebe', 'enfant', 'couches', 'nounou', 'creche'] },
  { emoji: '🎒', keywords: ['ecole', 'fournitures', 'cartable', 'rentree'] },
  { emoji: '🎓', keywords: ['etudes', 'universite', 'fac', 'formation', 'cours'] },
  { emoji: '🐕', keywords: ['chien', 'veterinaire', 'croquettes', 'toutou'] },
  { emoji: '🐈', keywords: ['chat', 'litiere', 'minou'] },
  { emoji: '🐾', keywords: ['animal', 'animalerie', 'veto'] },

  // Occasions
  { emoji: '🎁', keywords: ['cadeau', 'anniversaire', 'surprise', 'present'] },
  { emoji: '💐', keywords: ['fleurs', 'bouquet', 'fleuriste'] },
  { emoji: '🎄', keywords: ['noel', 'sapin', 'fetes'] },
  { emoji: '🎃', keywords: ['halloween', 'deguisement'] },
  { emoji: '🐣', keywords: ['paques', 'oeufs'] },
  { emoji: '❤️', keywords: ['amour', 'saint valentin', 'couple', 'coeur'] },
  { emoji: '💒', keywords: ['mariage', 'noces', 'ceremonie'] },
  { emoji: '🎉', keywords: ['fete', 'soiree', 'party', 'celebration', 'nouvel an'] },
  { emoji: '🎈', keywords: ['ballon', 'anniv', 'decoration fete'] },

  // Divers
  { emoji: '🚬', keywords: ['cigarettes', 'clopes', 'tabac', 'vape'] },
  { emoji: '🎰', keywords: ['pari', 'loto', 'fdj', 'jeux argent'] },
  { emoji: '📮', keywords: ['poste', 'timbre', 'courrier', 'lettre'] },
  { emoji: '🖨️', keywords: ['impression', 'photocopie', 'imprimeur'] },
  { emoji: '💼', keywords: ['travail', 'bureau', 'pro', 'materiel'] },
  { emoji: '🤝', keywords: ['remboursement', 'partage', 'avance', 'pret argent'] },
  { emoji: '❓', keywords: ['divers', 'autre', 'inconnu', 'quelconque'] },
]

/**
 * Fuzzy search over the catalogue: exact keyword > prefix > substring, then
 * catalogue order for stability. Empty query returns the whole catalogue.
 */
export function searchEmojis(query: string, limit = 60): EmojiEntry[] {
  const q = normalize(query.trim())
  if (!q) return EXPENSE_EMOJIS.slice(0, limit)

  const scored: { entry: EmojiEntry; score: number; index: number }[] = []
  EXPENSE_EMOJIS.forEach((entry, index) => {
    let best = 0
    for (const keyword of entry.keywords) {
      if (keyword === q) best = Math.max(best, 3)
      else if (keyword.startsWith(q)) best = Math.max(best, 2)
      else if (keyword.includes(q)) best = Math.max(best, 1)
      // Multi-word keywords also match on any word start ("forfait ski" for "ski").
      else if (keyword.includes(` ${q}`)) best = Math.max(best, 2)
    }
    if (best > 0) scored.push({ entry, score: best, index })
  })

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.entry)
}

/**
 * Best-effort emoji suggestion from a free-text description ("Courses Carrefour"
 * -> the shopping-cart emoji). Only whole-word or word-prefix matches, so short
 * noise words never trigger a random emoji. Returns null when nothing matches.
 */
export function suggestEmoji(description: string): string | null {
  const words = normalize(description).split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  let bestEmoji: string | null = null
  let bestScore = 0

  for (const entry of EXPENSE_EMOJIS) {
    for (const keyword of entry.keywords) {
      const keywordWords = keyword.split(' ')
      for (const word of words) {
        let score = 0
        if (keywordWords.includes(word)) score = 3
        else if (word.length >= 4 && keywordWords.some((kw) => kw.startsWith(word))) score = 2
        if (score > bestScore) {
          bestScore = score
          bestEmoji = entry.emoji
        }
      }
    }
  }

  return bestEmoji
}
