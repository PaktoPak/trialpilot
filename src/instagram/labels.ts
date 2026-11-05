// Pages load with ?hl=en, so English should match. The other languages cover accounts where
// Instagram keeps the account's own language anyway.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (words: string[]) => new RegExp(`^\\s*(${words.map(escape).join("|")})\\s*$`, "i");

export const labels = {
  newPostIcon: ["New post", "Nuovo post", "Nueva publicación", "Nouvelle publication", "Neuer Beitrag", "Nova publicação"],
  create: exact(["Create", "Crea", "Crear", "Créer", "Erstellen", "Criar"]),
  postMenuItem: exact(["Post"]),
  next: exact(["Next", "Avanti", "Siguiente", "Suivant", "Weiter", "Avançar"]),
  share: exact(["Share", "Condividi", "Compartir", "Partager", "Teilen", "Compartilhar"]),
  ok: exact(["OK"]),
  advancedSettings: exact(["Advanced settings", "Impostazioni avanzate"]),
  // The website's trial switch is "Enable trial reel"; trials it lists are labelled "Trial reel".
  trial: /trial reel|reel di prova/i,
};
