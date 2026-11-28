// backend/utils/tapHunt.js
//
// Phrase hunt. Taps occasionally drop one of the 24 words of TAP_PRIZE_MNEMONIC (env only, never
// logged). Each drop is hidden in a cover sentence and recorded for the finder. The drop chance
// depends on the leading player's distinct word count, so the hunt runs in four stages.
import { randomInt } from "crypto";
import { ethers } from "ethers";
import { recordHuntFind, leaderDistinctCount } from "../db/tapHunt.js";

const WORD_COUNT = 24;

const COVER_SENTENCES = [
  "The ferry slipped past the {word} just before dawn.",
  "Grandma's recipe card had a note in the margin: add {word} to taste.",
  "Nobody expected the old lighthouse to hide a {word} under the stairs.",
  "The kids spent the afternoon arguing about the {word} in the garden.",
  "Our neighbour swears the {word} was there yesterday.",
  "The museum guide paused at the {word} and told a long story nobody asked for.",
  "A weather report mentioned a sudden {word} over the harbour.",
  "The dog dragged a {word} across the kitchen floor again.",
  "Someone left a {word} on the train and nobody claimed it.",
  "The festival poster was mostly {word}, with a smaller line about the band.",
  "Every bakery in town sold a {word} shaped like a crown this week.",
  "On the forum, a stranger posted only the word {word} and vanished.",
  "The mechanic shrugged and said the engine just needed a {word}.",
  "Grandpa wrote the {word} in pencil on the back of a birthday card.",
  "The quiz host asked about the {word}, and the whole room went silent.",
  "During the storm, the radio kept repeating the word {word}.",
];

let huntWords;

/** The 24 hunt words from the env, or null if the hunt is not configured. Never logs the phrase. */
function loadHuntWords() {
  if (huntWords !== undefined) return huntWords;
  huntWords = null;
  const phrase = process.env.TAP_PRIZE_MNEMONIC;
  if (!phrase) return huntWords;
  try {
    const words = ethers.Mnemonic.fromPhrase(phrase).phrase.split(" ");
    if (words.length !== WORD_COUNT) throw new Error(`expected ${WORD_COUNT} words, got ${words.length}`);
    huntWords = words;
  } catch (err) {
    console.error("⚠️  TAP_PRIZE_MNEMONIC is invalid, phrase hunt disabled:", err.message);
  }
  return huntWords;
}

/** Chance that any one tap drops a word, given how many words the leading player holds. */
export function dropChance(leaderDistinct) {
  if (leaderDistinct < 6) return 1 / 500;
  if (leaderDistinct < 12) return 1 / 750;
  if (leaderDistinct < 18) return 1 / 1000;
  return 1 / 1500;
}

/**
 * Rolls for a word drop on one successful tap. Returns { word, sentence, isNew, won } when a word
 * drops, otherwise null. `won` is true when this drop completed the player's set of 24.
 */
export async function rollHuntDrop(userId) {
  const words = loadHuntWords();
  if (!words) return null;

  const leader = await leaderDistinctCount();
  if (leader === null) return null;
  if (Math.random() >= dropChance(leader)) return null;

  const index = randomInt(WORD_COUNT);
  const found = await recordHuntFind(userId, index);
  if (!found) return null;

  const word = words[index];
  return {
    word,
    sentence: COVER_SENTENCES[randomInt(COVER_SENTENCES.length)].replace("{word}", word),
    isNew: found.isNew,
    won: found.isNew && found.distinct === WORD_COUNT,
  };
}
