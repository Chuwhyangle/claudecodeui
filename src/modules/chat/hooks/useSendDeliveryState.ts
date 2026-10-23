import { useCallback, useEffect, useRef, useState } from 'react';

import { createSendDelivery } from '@/modules/chat/utils/session/sendDelivery';
import type { SendDelivery } from '@/modules/chat/utils/session/sendDelivery';
import type { ServerEvent } from '@/shared/types';

/**
 * Whether the last send was ever taken by the server, and the bookkeeping that
 * lets the composer answer that question.
 *
 * The send path lives in the composition (`useChatComposerState`) because it
 * stitches every concern together, but the *delivery* itself is a self-contained
 * machine: one in-flight send, the frame that acknowledges it, the deadline that
 * fails it, and the optimistic row a failure has to take back. That state has to
 * outlive a render and settle outside React, so it is kept here rather than in
 * the composition.
 */

type PendingDelivery = {
  sessionId: string;
  delivery: SendDelivery;
};

type UndeliveredTurn = {
  id: string;
  text: string;
};

type UseSendDeliveryStateArgs = {
  /**
   * Subscribes to every server frame, so the send path can hear the answer to
   * the message it just sent. The first frame the server addresses to the
   * session is the delivery's acknowledgement; silence past the deadline is
   * the failure.
   */
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
};

export function useSendDeliveryState({ subscribe }: UseSendDeliveryStateArgs) {
  /**
   * Whether the last send was never taken — the dock reports it in place of a
   * turn. Kept as state rather than derived from the delivery ref because the
   * machine settles outside React and the surface has to redraw when it does.
   */
  const [sendFailed, setSendFailed] = useState(false);
  // The one in-flight send whose acknowledgement (or deadline) is still being
  // awaited. Only ever one: a second submit while a send is unresolved is
  // ignored, so an answer can be attributed to the frame that produced it.
  const pendingDeliveryRef = useRef<PendingDelivery | null>(null);
  // The optimistic row a failed send left behind, so its retry re-shows the same
  // row instead of adding a second one for the same text.
  const undeliveredTurnRef = useRef<UndeliveredTurn | null>(null);

  // The server's answer to the send that is in flight. Any frame it addresses
  // to the session is the acknowledgement — it proves the socket is two-way and
  // the frame the send handed it was received. A `protocol_error` is the other
  // answer: the server read the send and refused it, so the send failed even
  // though frames are arriving. Frames for other sessions, and the synthetic
  // reconnect marker this client mints itself, prove nothing about this send.
  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }
    return subscribe((event) => {
      const pending = pendingDeliveryRef.current;
      if (!pending || pending.delivery.getPhase() !== 'sending') return;
      if (!event.kind || event.kind === 'websocket_reconnected') return;
      if (event.sessionId !== pending.sessionId) return;
      if (event.kind === 'protocol_error') {
        pending.delivery.fail();
        return;
      }
      pending.delivery.ack();
    });
  }, [subscribe]);

  useEffect(() => () => {
    pendingDeliveryRef.current?.delivery.dispose();
  }, []);

  /**
   * Starts watching one send to its answer.
   *
   * The caller keeps what a delivered or failed send means for the composer
   * (the row, the draft, the processing mark); this hook owns only the machine
   * and the slot it occupies, so the settle handler is cleared from the slot
   * before it runs and the next submit can never be resolved by this send's
   * frame.
   */
  const beginDelivery = useCallback((sessionId: string, onSettle: (phase: 'delivered' | 'failed') => void) => {
    const delivery = createSendDelivery({
      onSettle: (phase) => {
        if (pendingDeliveryRef.current?.delivery === delivery) {
          pendingDeliveryRef.current = null;
        }
        onSettle(phase);
      },
    });
    pendingDeliveryRef.current = { sessionId, delivery };
    setSendFailed(false);
    delivery.begin();
  }, []);

  return { sendFailed, setSendFailed, beginDelivery, pendingDeliveryRef, undeliveredTurnRef };
}
