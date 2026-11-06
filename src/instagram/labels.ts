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
  shared: /(has been shared|post shared|reel shared|è stato condiviso|se ha compartido|a été partagé|wurde geteilt|foi compartilhad)/i,
  shareFailed: /(couldn't be shared|could not be shared|wasn't shared|something went wrong|non è stato possibile condividere|si è verificato un problema)/i,
  advancedSettings: exact(["Advanced settings", "Impostazioni avanzate"]),
  // The website's trial switch is "Enable trial reel"; trials it lists are labelled "Trial reel".
  trial: /trial reel|reel di prova/i,
};
