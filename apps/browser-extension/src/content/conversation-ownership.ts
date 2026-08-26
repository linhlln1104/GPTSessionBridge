export interface ConversationSurface<Message extends object> {
  readonly assistantMessageCount: number;
  readonly pathname: string;
  readonly userMessages: readonly Message[];
}

const DOCUMENT_POSITION_DISCONNECTED = 0x01;
const DOCUMENT_POSITION_FOLLOWING = 0x04;
const DOCUMENT_POSITION_CONTAINS = 0x08;
const DOCUMENT_POSITION_CONTAINED_BY = 0x10;

export type ReadVisibleMessageText<Message extends object> = (message: Message) => string;

/** Binds the adapter to the fresh conversation that receives its first turn. */
export class ConversationOwnershipGuard<Message extends object> {
  #conversationPath: string | undefined;
  #ownedUserMessages: readonly Message[] | undefined;

  public assertSurface(surface: ConversationSurface<Message>): void {
    const owned = this.#ownedUserMessages;
    if (owned === undefined) {
      if (
        surface.pathname !== "/" ||
        surface.userMessages.length > 0 ||
        surface.assistantMessageCount > 0
      ) {
        throw new Error("conversation_not_fresh");
      }
      return;
    }
    if (
      surface.userMessages.length !== owned.length ||
      owned.some((message, index) => surface.userMessages[index] !== message)
    ) {
      throw new Error("conversation_ownership_lost");
    }
    this.#assertPath(surface.pathname);
  }

  public adoptTurn(
    baselineUsers: ReadonlySet<Message>,
    surface: ConversationSurface<Message>,
    expectedText: string,
    readVisibleText: ReadVisibleMessageText<Message>,
  ): Message {
    const fresh = surface.userMessages.filter((message) => !baselineUsers.has(message));
    if (fresh.length !== 1) {
      throw new Error("conversation_turn_unconfirmed");
    }
    const candidate = fresh[0];
    if (
      candidate === undefined ||
      canonicalizeVisibleMessageText(readVisibleText(candidate)) !==
        canonicalizeVisibleMessageText(expectedText)
    ) {
      throw new Error("conversation_turn_content_mismatch");
    }
    const owned = this.#ownedUserMessages;
    if (owned === undefined) {
      if (baselineUsers.size !== 0) {
        throw new Error("conversation_ownership_unconfirmed");
      }
      this.#ownedUserMessages = Object.freeze([candidate]);
      if (surface.pathname !== "/") {
        this.#conversationPath = surface.pathname;
      }
      return candidate;
    }
    if (
      baselineUsers.size !== owned.length ||
      owned.some((message) => !baselineUsers.has(message)) ||
      surface.userMessages.length !== owned.length + 1 ||
      owned.some((message, index) => surface.userMessages[index] !== message)
    ) {
      throw new Error("conversation_ownership_lost");
    }
    this.#assertPath(surface.pathname);
    this.#ownedUserMessages = Object.freeze([...surface.userMessages]);
    return candidate;
  }

  #assertPath(pathname: string): void {
    if (this.#conversationPath === undefined) {
      if (pathname !== "/") {
        this.#conversationPath = pathname;
      }
    } else if (pathname !== this.#conversationPath) {
      throw new Error("conversation_path_changed");
    }
  }
}

export function canonicalizeVisibleMessageText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/[\t ]+(?=\n|$)/gu, "")
    .trimEnd();
}

export function isStrictlyFollowingDocumentPosition(position: number): boolean {
  return (
    Number.isInteger(position) &&
    (position & DOCUMENT_POSITION_FOLLOWING) !== 0 &&
    (position &
      (DOCUMENT_POSITION_DISCONNECTED |
        DOCUMENT_POSITION_CONTAINS |
        DOCUMENT_POSITION_CONTAINED_BY)) ===
      0
  );
}
