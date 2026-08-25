import type { Readable, Writable } from "node:stream";

import type { AppServerEnvelope } from "@gpt-session-bridge/protocol";

import type { AppServerRouter } from "./app-server-router.js";
import { AppServerTransportError } from "../transport/errors.js";
import { AppServerJsonLineDecoder } from "../transport/jsonl-decoder.js";
import { AppServerJsonLineWriter } from "../transport/jsonl-writer.js";

export interface BidirectionalProxyOptions {
  readonly clientInput: Readable;
  readonly clientOutput: Writable;
  readonly maxBufferedBytes: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedMessages: number;
  readonly router: AppServerRouter;
  readonly serverInput: Writable;
  readonly serverOutput: Readable;
}

export type ProxyEndReason = "client-ended" | "server-ended" | "stopped";

export class BidirectionalAppServerProxy {
  readonly #clientWriter: AppServerJsonLineWriter;
  readonly #clientPump: DirectionalPump;
  readonly #router: AppServerRouter;
  readonly #serverWriter: AppServerJsonLineWriter;
  readonly #serverPump: DirectionalPump;
  #resolveStop: (() => void) | undefined;
  #running = false;
  #stopRequested = false;

  public constructor(options: BidirectionalProxyOptions) {
    this.#router = options.router;
    const decoderOptions = {
      maxBufferedBytes: options.maxBufferedBytes,
      maxFrameBytes: options.maxFrameBytes,
    };
    const writerOptions = {
      maxFrameBytes: options.maxFrameBytes,
      maxQueuedBytes: options.maxBufferedBytes,
      maxQueuedMessages: options.maxQueuedMessages,
    };
    this.#clientWriter = new AppServerJsonLineWriter(options.clientOutput, writerOptions);
    this.#serverWriter = new AppServerJsonLineWriter(options.serverInput, writerOptions);
    this.#clientPump = new DirectionalPump(
      options.clientInput,
      new AppServerJsonLineDecoder(decoderOptions),
      async (envelope) => this.#dispatchClient(envelope),
    );
    this.#serverPump = new DirectionalPump(
      options.serverOutput,
      new AppServerJsonLineDecoder(decoderOptions),
      async (envelope) => this.#dispatchServer(envelope),
    );
  }

  public async run(): Promise<ProxyEndReason> {
    if (this.#running) {
      throw new AppServerTransportError("transport_closed");
    }
    this.#running = true;
    const clientCompletion = this.#clientPump.start().then(() => "client-ended" as const);
    const serverCompletion = this.#serverPump.start().then(() => "server-ended" as const);
    const stopCompletion = new Promise<"stopped">((resolve) => {
      this.#resolveStop = () => {
        resolve("stopped");
      };
      if (this.#stopRequested) {
        this.#resolveStop();
      }
    });

    try {
      return await Promise.race([clientCompletion, serverCompletion, stopCompletion]);
    } finally {
      this.#clientPump.stop();
      this.#serverPump.stop();
      this.#clientWriter.close();
      this.#serverWriter.close();
      this.#router.clearPending();
      this.#resolveStop = undefined;
    }
  }

  public stop(): void {
    this.#stopRequested = true;
    this.#resolveStop?.();
  }

  async #dispatchClient(envelope: AppServerEnvelope): Promise<void> {
    const dispatch = this.#router.handleClient(envelope);
    if (dispatch.kind === "drop") {
      return;
    }
    await (dispatch.kind === "forward" ? this.#serverWriter : this.#clientWriter).write(
      dispatch.envelope,
    );
  }

  async #dispatchServer(envelope: AppServerEnvelope): Promise<void> {
    const dispatch = this.#router.handleServer(envelope);
    if (dispatch.kind === "drop") {
      return;
    }
    await (dispatch.kind === "forward" ? this.#clientWriter : this.#serverWriter).write(
      dispatch.envelope,
    );
  }
}

class DirectionalPump {
  readonly #decoder: AppServerJsonLineDecoder;
  readonly #dispatch: (envelope: AppServerEnvelope) => Promise<void>;
  readonly #source: Readable;
  #active = false;
  #chain = Promise.resolve();
  #reject: ((error: AppServerTransportError) => void) | undefined;
  #resolve: (() => void) | undefined;

  readonly #onData = (chunk: Buffer | string): void => {
    this.#source.pause();
    this.#chain = this.#chain
      .then(async () => {
        for (const envelope of this.#decoder.push(chunk)) {
          await this.#dispatch(envelope);
        }
      })
      .then(
        () => {
          if (this.#active) {
            this.#source.resume();
          }
        },
        () => {
          this.#fail();
        },
      );
  };

  readonly #onEnd = (): void => {
    this.#chain = this.#chain
      .then(async () => {
        for (const envelope of this.#decoder.finish()) {
          await this.#dispatch(envelope);
        }
      })
      .then(
        () => {
          this.#finish();
        },
        () => {
          this.#fail();
        },
      );
  };

  readonly #onError = (): void => {
    this.#fail();
  };

  public constructor(
    source: Readable,
    decoder: AppServerJsonLineDecoder,
    dispatch: (envelope: AppServerEnvelope) => Promise<void>,
  ) {
    this.#source = source;
    this.#decoder = decoder;
    this.#dispatch = dispatch;
  }

  public start(): Promise<void> {
    if (this.#active) {
      return Promise.reject(new AppServerTransportError("transport_closed"));
    }
    this.#active = true;
    const completion = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#source.on("data", this.#onData);
    this.#source.once("end", this.#onEnd);
    this.#source.once("error", this.#onError);
    return completion;
  }

  public stop(): void {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    this.#source.pause();
    this.#source.off("data", this.#onData);
    this.#source.off("end", this.#onEnd);
    this.#source.off("error", this.#onError);
  }

  #finish(): void {
    if (!this.#active) {
      return;
    }
    this.stop();
    this.#resolve?.();
  }

  #fail(): void {
    if (!this.#active) {
      return;
    }
    this.stop();
    this.#reject?.(new AppServerTransportError("transport_closed"));
  }
}
