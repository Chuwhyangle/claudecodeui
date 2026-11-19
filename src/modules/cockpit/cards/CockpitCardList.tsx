import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';

import type {
  CockpitCard as CockpitCardData,
  CockpitCardKind,
  LLMProvider,
} from '@/shared/types';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { cn } from '@/shared/utils';
import { cockpitCardDescriptor } from '@/modules/cockpit/cockpitCardDescriptors';
import type { CockpitCardTypeFilter } from '@/modules/cockpit/cards/cockpitCardController';
import { cockpitCardsReading } from '@/modules/cockpit/cards/cockpitCardController';
import CockpitCard from '@/modules/cockpit/cards/CockpitCard';
import { cockpitCardQuestionOf } from '@/modules/cockpit/cards/cockpitCardDuplicates';
import CockpitCardDetails from '@/modules/cockpit/cards/CockpitCardDetails';
import type { CockpitStartConversationView } from '@/modules/cockpit/cards/CockpitCardStartConversationAction';
import type {
  CockpitStartConversationCreated,
  CockpitStartConversationProject,
} from '@/modules/cockpit/cards/cockpitCardStartConversation';
import { useCockpitCards } from '@/modules/cockpit/hooks/useCockpitCards';
import type { CockpitCardsBinding } from '@/modules/cockpit/hooks/useCockpitCards';
import { useCockpitStartConversation } from '@/modules/cockpit/hooks/useCockpitStartConversation';
import { useOptionalOptimisticSession } from '@/shared/context/OptimisticSessionContext';

/**
 * The cards view's container: filters and density at the top, the card list and the Details
 * drawer. The confirmation is NOT drawn here: a pending confirmation turns the card's own bar
 * (or the drawer's) into its confirm state in place, so no dialog is mounted at the list level.
 *
 * IT IS A CONTAINER, NOT A SECOND MODEL. Every reading comes from a card binding (the page's own
 * `useCockpitCards`, or the column's shared one), and every command is one of that controller's.
 * The root publishes `data-cockpit-cards` — the same reading a scenario runner would otherwise
 * infer from the DOM — so visible order, selection, each card's shown option and confirm target,
 * and whether Details is open are all machine-readable. The pending confirm state is published
 * by the bar that draws it (`data-confirm-pending` + `data-card-id`), not by this container.
 *
 * TWO VARIANTS, ONE LIST. `page` is `/cockpit?view=cards`: the Details drawer floats over the
 * page and the list owns the global number keys. `column` is the PC right column: Details is
 * PUSHED INSIDE the list (with a back button, so the left session is never covered), and the
 * list owns no global keys — the column's own controller owns them, because it must also decide
 * whether the keyboard belongs to either input box.
 */

/** Every known card kind, in the order the type filter lists them. */
const KNOWN_KINDS: readonly CockpitCardKind[] = ['need', 'stuck', 'fix', 'ask', 'multi', 'decision'];

export type CockpitCardListVariant = 'page' | 'column';

export type CockpitCardListProps = {
  /**
   * The card binding to draw. Absent means "bind the page's own controller" — the `/cockpit`
   * cards view. The column passes its shared binding so the header count and the list are one
   * reading and one poll.
   */
  binding?: CockpitCardsBinding;
  /** `page` floats Details; `column` pushes it inside and leaves the keys to the column. */
  variant?: CockpitCardListVariant;
  /** The column's conversation link: open on the left, recording which card was opened. */
  onOpenConversation?: (card: CockpitCardData, sessionId: string) => void;
  /** The card currently opened on the left (the column marks it; the page passes nothing). */
  openedCardId?: string | null;
  /**
   * The session the left pane currently shows, read from the route by the column. Details marks
   * a card whose `conversation.sessionId` equals it as already open. Passed only by the column:
   * the phone/page variant leaves it null, so its link is unchanged.
   */
  currentSessionId?: string | null;
  /** The column's back button; defaults to closing the Details stack entry. */
  onBack?: () => void;
  /**
   * The registered cockpit projects a card's 「start a conversation」 may name, when the surface
   * has already read them (the cockpit page has). Absent means the flow reads the fleet registry
   * on the first press.
   */
  registeredProjects?: readonly CockpitStartConversationProject[] | null;
  /**
   * Registers a session the start flow created. Defaults to the workspace's optimistic
   * registration when this list is mounted inside the project state; a surface above it simply
   * navigates. A criterion passes its own recorder.
   */
  onSessionCreated?: (created: CockpitStartConversationCreated) => void;
  /** Opens a created session; defaults to the conversation link's own navigation. */
  onNavigateToSession?: (sessionId: string) => void;
  /** The LLM the new conversation runs on; production leaves the server's default (`claude`). */
  sessionProvider?: LLMProvider;
};

export default function CockpitCardList(props: CockpitCardListProps) {
  // Two components, not an if after a hook: the page's variant binds its own controller only
  // when no binding was handed in, so the column never starts a second poll for the same cards.
  return props.binding === undefined ? (
    <CockpitCardListWithOwnController {...props} />
  ) : (
    <CockpitCardListBound binding={props.binding} {...props} />
  );
}

function CockpitCardListWithOwnController(props: Omit<CockpitCardListProps, 'binding'>) {
  const binding = useCockpitCards();
  // `binding` goes AFTER the spread, not before: a caller that forwards its own optional
  // `binding={maybeUndefined}` leaves the key on the props object, and a spread after this prop
  // would overwrite the controller this component just bound with that `undefined` — crashing
  // the list. "Absent" in the prop contract means `undefined`, so it must reach here too.
  return <CockpitCardListBound {...props} binding={binding} />;
}

function CockpitCardListBound({
  binding,
  variant = 'page',
  onOpenConversation,
  openedCardId = null,
  currentSessionId = null,
  onBack,
  registeredProjects = null,
  onSessionCreated,
  onNavigateToSession,
  sessionProvider,
}: CockpitCardListProps & { binding: CockpitCardsBinding }) {
  const { t } = useTranslation();
  // The page's Details is a bottom sheet on a phone and a centred card on a wide screen. The
  // column variant pushes its Details inside instead, so it never asks this question.
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { snapshot, controller } = binding;
  // The workspace's optimistic-session seam, when this list is mounted INSIDE its provider (the
  // PC column is; the cockpit page and the phone overlay are above it). It is the seam that
  // registers a started session optimistically; its absence only means this surface navigates
  // without registering. It is read from the shared context rather than the workspace module so
  // the cockpit does not import `@/modules/project-workspace` (the pinned feature-level cycle).
  const projectState = useOptionalOptimisticSession();
  // The project drawer is open/closed state, not a filter: it is a transient overlay the person
  // dismisses, so it has no reason to outlive the visit (the selection itself is persisted).
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  // The page's own scroll container. Only the `page` variant owns the offset: the column keeps
  // its own layout (and its Details is pushed inside), so reporting its scroll there would write
  // the column's position into the reading the phone page restores.
  const scrollRef = useRef<HTMLElement>(null);
  // Restored once, and only after the first successful read: before the cards exist the section
  // has no height to scroll, so an earlier write would be clamped to 0.
  const scrollRestoredRef = useRef(false);
  // The list's offset while Details is PUSHED INSIDE this same scroller (the column variant).
  // The swap replaces the section's only child with the detail, whose own body scrolls, so the
  // section no longer overflows and the browser clamps `scrollTop` to 0. The offset has to be
  // kept here and put back when the list returns; reading it after the swap would already be 0.
  // It is NOT reported to the controller's memory: that memory is the phone page's route
  // reading, and the column must not overwrite it (see `handleScroll`).
  const listScrollTopRef = useRef(0);
  // Whether the previous render had Details inside, so only the closing edge restores. A ref
  // rather than state: the transition, not a rendered value, is what this effect reacts to.
  const detailsInsideWasRef = useRef(false);

  useEffect(() => {
    if (variant !== 'page' || scrollRestoredRef.current) return;
    if (snapshot.status !== 'loaded') return;
    const element = scrollRef.current;
    if (element === null) return;
    scrollRestoredRef.current = true;
    if (snapshot.scrollPosition > 0) element.scrollTop = snapshot.scrollPosition;
  }, [snapshot.scrollPosition, snapshot.status, variant]);

  /** Every scroll event persists the offset in the controller's memory (see `CockpitCardMemory`). */
  const handleScroll = (): void => {
    if (variant !== 'page') return;
    const element = scrollRef.current;
    if (element !== null) controller.setScrollPosition(element.scrollTop);
  };

  // Number keys select options; Escape is deliberately absent (it aborts a running turn
  // elsewhere in the app, and the cockpit must never swallow it). Keys typed into a field belong
  // to that field, so an editable target ends the handler.
  //
  // THE COLUMN VARIANT DOES NOT REGISTER THIS. There the column controller owns the keyboard:
  // it is the one that knows whether either input box has focus, and it routes the same digits
  // here. Two window listeners would apply one press twice.
  useEffect(() => {
    if (variant !== 'page') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          return;
        }
        // Enter on a focused control belongs to that control's own activation (the confirm
        // button turns its own state, a card's zone opens Details). Consuming it here as well
        // would make one press do two things — and the second press would send what the first
        // had just opened.
        if (
          event.key === 'Enter'
          && target.closest('button, a[href], [role="button"], [role="radio"]') !== null
        ) {
          return;
        }
      }
      if (controller.handleKey(event.key)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, variant]);

  const reading = cockpitCardsReading(snapshot);
  // ONE COUNT LINE, THREE READINGS. The column used to say `5 waiting for you` in its title and
  // the list repeated `5 cards, 1 waiting for the fleet to confirm` below it: the same total twice.
  // The three numbers below are a partition of the cards on screen — not yet answered, answered
  // and still awaiting the fleet's receipt, answered and acknowledged by the fleet (the notice
  // the server keeps beside the card). The title no longer draws a count of its own.
  const answeredCount = snapshot.visibleCards.filter(
    (card) => card.feedbackNotice !== undefined,
  ).length;
  const countSummary = {
    needsYou: Math.max(0, snapshot.visibleCards.length - reading.awaitingFeedback - answeredCount),
    waiting: reading.awaitingFeedback,
    answered: answeredCount,
  };
  const detailsCardId = reading.detailsOpenCardId;
  const detailsCard =
    detailsCardId === null ? null : snapshot.cards.find((card) => card.id === detailsCardId) ?? null;
  const detailsInsideColumn = variant === 'column' && detailsCard !== null;
  // The column's Details is drawn INSTEAD of the list, in the same scroll container. Returning
  // to the list therefore lands at its top unless the offset is put back after the list is in
  // the DOM again — the offset itself was recorded when Details opened (see `openCardDetails`),
  // because the swap has already clamped it to 0 by the time this effect runs.
  useLayoutEffect(() => {
    if (variant !== 'column') return;
    const wasInside = detailsInsideWasRef.current;
    detailsInsideWasRef.current = detailsInsideColumn;
    if (!wasInside || detailsInsideColumn) return;
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = listScrollTopRef.current;
  }, [detailsInsideColumn, variant]);
  /**
   * The created session's registration. The caller's own recorder wins; otherwise the workspace's
   * optimistic registration is used when this list is inside the project state AND the registered
   * project is one of its projects. Nothing is invented for a path the workspace does not list —
   * the route still opens, the sidebar simply learns the row from the next read.
   */
  const registerStartedSession = (created: CockpitStartConversationCreated): void => {
    if (onSessionCreated !== undefined) {
      onSessionCreated(created);
      return;
    }
    if (projectState === null) return;
    const project = projectState.projects.find(
      (candidate) => (candidate.fullPath || candidate.path || '') === created.project.projectPath,
    );
    if (project === undefined) return;
    projectState.registerOptimisticSession({
      sessionId: created.sessionId,
      provider: created.provider,
      project,
      summary: '',
    });
  };
  /**
   * Opening the created session. The caller's own navigation wins; otherwise the surface's
   * conversation link (the column opens it on the left, the overlay closes itself over it). Every
   * production surface hands one over — the standalone page its `onNavigateToSession`, the other
   * two their `onOpenConversation` — so a started session is never left unopened.
   */
  const openStartedSession = (sessionId: string): void => {
    if (onNavigateToSession !== undefined) {
      onNavigateToSession(sessionId);
      return;
    }
    if (onOpenConversation !== undefined && detailsCard !== null) {
      onOpenConversation(detailsCard, sessionId);
    }
  };
  const startConversation = useCockpitStartConversation({
    registeredProjects,
    onCreated: registerStartedSession,
    onNavigate: openStartedSession,
    provider: sessionProvider,
  });
  /** One card's reading; every other card draws the idle control (no error leaked across cards). */
  const startConversationView = (card: CockpitCardData): CockpitStartConversationView => ({
    status: startConversation.snapshot.cardId === card.id ? startConversation.snapshot.status : 'idle',
    error: startConversation.snapshot.cardId === card.id ? startConversation.snapshot.error : null,
    onStart: () => startConversation.start(card),
  });
  // The confirm state belongs to ONE card, and every bar that card has (the card's own, and the
  // Details drawer's — a longer reading of the same card) draws it. A bar of another card stays
  // in its idle state, and the outcome is drawn only by the card that asked. A running delayed
  // send and an in-flight request name their card too: the bar must keep drawing the same state
  // — countdown, then 「sending」 — instead of flashing back to its idle label between them.
  const countdownFor = (cardId: string) =>
    snapshot.sendCountdown !== null && snapshot.sendCountdown.cardId === cardId
      ? snapshot.sendCountdown
      : null;
  const pendingCardId =
    snapshot.pendingConfirm?.cardId ?? snapshot.sendCountdown?.cardId ?? snapshot.confirmingCardId;
  const confirmingCardId = snapshot.confirmingCardId;
  const outcomeFor = (cardId: string) =>
    snapshot.lastOutcome !== null && snapshot.lastOutcome.cardId === cardId
      ? snapshot.lastOutcome
      : null;
  const closeDetails = (): void => {
    if (onBack !== undefined) {
      onBack();
      return;
    }
    controller.closeDetails();
  };
  /**
   * Opening one card. The list's offset is recorded BEFORE the command, while the list still
   * owns the section: the column's swap clamps `scrollTop` to 0, so a later read would restore
   * the top instead of the card the person opened. The page variant's Details floats over the
   * list and changes no offset, so recording there is harmless.
   */
  const openCardDetails = (cardId: string): void => {
    const element = scrollRef.current;
    if (element !== null) listScrollTopRef.current = element.scrollTop;
    controller.openDetails(cardId);
  };

  // The type chips, in the order the list draws them. Each carries the count of cards that would
  // remain under the CURRENT PROJECT selection, so pressing a chip never promises a number the
  // list then does not show.
  const typeChips: { value: CockpitCardTypeFilter; label: string }[] = [
    { value: 'all', label: t('cockpit.cardFilterAll') },
    ...KNOWN_KINDS.map((kind) => ({
      value: kind as CockpitCardTypeFilter,
      label: t(cockpitCardDescriptor(kind).labelKey),
    })),
  ];
  // The project chip names the selection: one project by name, a count when several, or
  // 「All projects」 when none. The drawer, not the chip, is where the set is changed.
  const projectChipLabel =
    snapshot.projectFilters.length === 0
      ? t('cockpit.cardFilterAllProjects')
      : snapshot.projectFilters.length === 1
        ? snapshot.projectFilters[0]!
        : t('cockpit.cardFilterSelectedCount', { n: snapshot.projectFilters.length });

  return (
    <section
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="cockpit-card-list"
      data-cockpit-cards={JSON.stringify(reading)}
      data-cockpit-card-list-variant={variant}
      className={cn(
        'flex min-h-0 flex-1 flex-col p-2',
        detailsInsideColumn ? 'overflow-hidden' : 'overflow-auto',
      )}
    >
      {detailsInsideColumn && detailsCard !== null ? (
        <div
          data-testid="cockpit-column-details"
          data-card-id={detailsCard.id}
          className="flex min-h-0 flex-1 flex-col"
        >
          <button
            type="button"
            data-testid="cockpit-column-back"
            onClick={closeDetails}
            className="mb-2 flex flex-shrink-0 items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t('cockpit.columnBack')}
          </button>
          <CockpitCardDetails
            inline
            card={detailsCard}
            now={snapshot.now}
            brief={snapshot.briefs[detailsCard.id]}
            onRetryBrief={() => controller.loadBrief(detailsCard.id)}
            onClose={closeDetails}
            shown={snapshot.shown[detailsCard.id]}
            ownReply={snapshot.ownReplies[detailsCard.id] ?? ''}
            onShowOption={(optionId: string) => controller.showOption(detailsCard.id, optionId)}
            onShowOwnReply={() => controller.showOwnReply(detailsCard.id)}
            onOwnReplyChange={(text: string) => controller.setOwnReply(detailsCard.id, text)}
            target={snapshot.targets[detailsCard.id] ?? null}
            onRequestConfirm={() => controller.requestConfirm(detailsCard.id)}
            confirmPending={pendingCardId === detailsCard.id}
            sendCountdown={countdownFor(detailsCard.id)}
            confirming={confirmingCardId === detailsCard.id}
            confirmOutcome={outcomeFor(detailsCard.id)}
            onConfirm={() => void controller.confirm()}
            onCancelConfirm={() => controller.cancelConfirm()}
            dismissTarget={snapshot.dismissTargets[detailsCard.id] ?? null}
            dismissPending={snapshot.pendingDismiss?.cardId === detailsCard.id}
            dismissing={snapshot.dismissingCardId === detailsCard.id}
            dismissNotice={
              snapshot.dismissNotice?.cardId === detailsCard.id ? snapshot.dismissNotice : null
            }
            onRequestDismiss={() => controller.requestDismiss(detailsCard.id)}
            onConfirmDismiss={() => void controller.confirmDismiss()}
            onCancelDismiss={() => controller.cancelDismiss()}
            openedInSession={openedCardId === detailsCard.id}
            currentSessionId={currentSessionId}
            onOpenConversation={(sessionId: string) => onOpenConversation?.(detailsCard, sessionId)}
            startConversation={startConversationView(detailsCard)}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 pb-2">
            {/* The dismiss answer. It lives HERE rather than on the card because a successful
                dismiss usually removes the card in the same read: the line that says 「已忽略」
                has to outlive the row it was pressed on. */}
            {snapshot.dismissNotice !== null && (
              <p
                role={snapshot.dismissNotice.ok ? 'status' : 'alert'}
                data-testid="cockpit-card-dismiss-notice"
                data-ok={snapshot.dismissNotice.ok ? 'true' : 'false'}
                className={cn(
                  'w-full text-[11px]',
                  snapshot.dismissNotice.ok ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {snapshot.dismissNotice.message}
              </p>
            )}
            {/* One line, three readings: what needs the person, what the person answered that the
                fleet has not acknowledged, and what the fleet acknowledged but the provider still
                lists. It replaces BOTH the column title's count and the old second line. */}
            <p
              data-testid="cockpit-card-count-summary"
              data-needs-you={countSummary.needsYou}
              data-waiting={countSummary.waiting}
              data-answered={countSummary.answered}
              className="w-full text-[11px] text-muted-foreground"
            >
              {t('cockpit.cardCountSummary', {
                needsYou: countSummary.needsYou,
                waiting: countSummary.waiting,
                answered: countSummary.answered,
              })}
            </p>
            {/*
              THE TYPE CHIPS. A horizontally scrollable row rather than a dropdown: the counts are
              the point (a person reads what is waiting per type before choosing), and a closed
              select shows none of them. The chip carries the count as its own number, so it is
              readable both by eye and by a test that reads the chip.
            */}
            <div
              role="group"
              aria-label={t('cockpit.cardFilterType')}
              data-testid="cockpit-card-filter-types"
              // The row scrolls horizontally on a 440px column, where the last chip used to be cut
              // with no sign there was more. `pr-6` keeps the last chip clear of the mask's edge
              // when everything fits, so the fade only ever covers the chip the viewport cuts.
              style={{
                maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent)',
                WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent)',
              }}
              className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto pr-6"
            >
              {typeChips.map((chip) => {
                const active = snapshot.typeFilter === chip.value;
                const count = snapshot.typeCounts[chip.value] ?? 0;
                return (
                  <button
                    key={chip.value}
                    type="button"
                    data-testid={`cockpit-card-filter-type-${chip.value}`}
                    data-count={count}
                    aria-pressed={active}
                    onClick={() => controller.setTypeFilter(chip.value)}
                    className={cn(
                      'flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <span>{chip.label}</span>
                    <span
                      data-testid={`cockpit-card-filter-count-${chip.value}`}
                      className="tabular-nums text-[11px] opacity-80"
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* The project chip opens the multi-select drawer; it never filters on its own. */}
            <button
              type="button"
              data-testid="cockpit-card-filter-project"
              aria-haspopup="dialog"
              aria-expanded={projectDrawerOpen}
              onClick={() => setProjectDrawerOpen((open) => !open)}
              className={cn(
                'flex min-w-0 max-w-44 shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs',
                snapshot.projectFilters.length > 0
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent',
              )}
            >
              <span className="truncate">{projectChipLabel}</span>
              <span aria-hidden className="text-[10px]">
                ▾
              </span>
            </button>

            <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('cockpit.cardsView')}>
              <button
                type="button"
                data-testid="cockpit-card-density-cards"
                aria-pressed={snapshot.density === 'cards'}
                onClick={() => controller.setDensity('cards')}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs',
                  snapshot.density === 'cards'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {t('cockpit.cardDensityCards')}
              </button>
              <button
                type="button"
                data-testid="cockpit-card-density-compact"
                aria-pressed={snapshot.density === 'compact'}
                onClick={() => controller.setDensity('compact')}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs',
                  snapshot.density === 'compact'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {t('cockpit.cardDensityCompact')}
              </button>
            </div>
          </div>

          {/*
            THE PROJECT DRAWER. A bottom sheet on a phone and a centred card on a wide screen:
            one dialog, positioned by breakpoint. Each row is a checkbox, so the set is built
            without closing the sheet, and the count beside a project is what the TYPE filter
            would leave there. 「Show N items」 states what the list behind it will draw.
          */}
          {projectDrawerOpen && (
            <div
              data-testid="cockpit-card-project-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={t('cockpit.cardFilterProjectsTitle')}
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-2 sm:items-center"
            >
              <div className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-xl border border-border bg-card p-3 text-card-foreground shadow-xl">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {t('cockpit.cardFilterProjectsTitle')}
                  </p>
                  <button
                    type="button"
                    data-testid="cockpit-card-project-clear"
                    onClick={() => controller.clearProjectFilters()}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                  >
                    {t('cockpit.cardFilterClear')}
                  </button>
                </div>
                <ul className="mt-2 min-h-0 flex-1 overflow-y-auto">
                  {snapshot.projects.map((project) => (
                    <li key={project}>
                      <label className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-accent">
                        <input
                          type="checkbox"
                          data-testid={`cockpit-card-project-option-${project}`}
                          checked={snapshot.projectFilters.includes(project)}
                          onChange={() => controller.toggleProjectFilter(project)}
                          className="h-4 w-4"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{project}</span>
                        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                          {snapshot.projectCounts[project] ?? 0}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  data-testid="cockpit-card-project-done"
                  onClick={() => setProjectDrawerOpen(false)}
                  className="mt-2 rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  {t('cockpit.cardFilterShow', { n: snapshot.visibleCards.length })}
                </button>
              </div>
            </div>
          )}

          {snapshot.status === 'error' && snapshot.error !== null && (
            <p role="alert" data-testid="cockpit-card-error" className="pb-2 text-xs text-destructive">
              {t('cockpit.cardError', { reason: snapshot.error })}
            </p>
          )}

          {/*
            A PROVIDER FAILURE IS NOT AN EMPTY WALL. The request succeeded, so `status` stays
            `loaded`; what failed is one provider's own read, and the healthy cards from the other
            providers stay on screen. The line is persistent (not a toast) because the wall is
            still incomplete until the provider recovers, and it carries the same retry the list
            already owns (`controller.load`). Background polling keeps running, so the next
            successful answer replaces `providerFailures` wholesale and the line clears itself.
          */}
          {snapshot.providerFailures.length > 0 && (
            <div
              role="alert"
              data-testid="cockpit-card-provider-error"
              data-providers={snapshot.providerFailures
                .map((failure) => failure.provider)
                .join(',')}
              className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
            >
              <span className="min-w-0 flex-1">
                {t('cockpit.cardProviderError', {
                  providers: snapshot.providerFailures
                    .map((failure) => failure.provider)
                    .join(', '),
                  reason: snapshot.providerFailures
                    .map(
                      (failure) => failure.reason ?? t('cockpit.cardProviderNoReason'),
                    )
                    .join('; '),
                })}
              </span>
              <button
                type="button"
                data-testid="cockpit-card-provider-retry"
                onClick={() => void controller.load()}
                className="shrink-0 rounded-md border border-destructive/40 px-2 py-0.5 text-[11px] hover:bg-destructive/10"
              >
                {t('cockpit.cardProviderRetry')}
              </button>
            </div>
          )}

          {/*
            AN INCOMPLETE READ IS NOT A COMPLETE WALL. A provider can answer `ok:true` with a
            batch it knows is short — a salvaged read cut at the byte bound (`truncated`) or one
            that skipped malformed lines. The cards are real and stay on screen, but the list is
            known-incomplete, so the person is owed that fact and the provider's own reason.
            This is a warning, not the failure banner above: the two are independent readings and
            both are drawn when both are present. Background polling replaces both wholesale, so
            the next healthy answer clears them without any local rule.
          */}
          {snapshot.providerWarnings.length > 0 && (
            <div
              role="status"
              data-testid="cockpit-card-provider-warning"
              data-providers={snapshot.providerWarnings
                .map((warning) => warning.provider)
                .join(',')}
              className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400"
            >
              <span className="min-w-0 flex-1">
                {t('cockpit.cardProviderWarning', {
                  providers: snapshot.providerWarnings
                    .map((warning) => warning.provider)
                    .join(', '),
                  reason: snapshot.providerWarnings
                    .map(
                      (warning) => warning.reason ?? t('cockpit.cardProviderNoReason'),
                    )
                    .join('; '),
                })}
              </span>
            </div>
          )}

          {snapshot.visibleCards.length === 0 &&
            snapshot.status === 'loaded' &&
            snapshot.providerFailures.length === 0 &&
            snapshot.providerWarnings.length === 0 && (
              <p data-testid="cockpit-card-empty" className="text-xs text-muted-foreground">
                {t('cockpit.cardEmpty')}
              </p>
            )}

          <div className="flex flex-col gap-2">
            {snapshot.visibleCards.map((card) => (
              <CockpitCard
                key={card.id}
                card={card}
                now={snapshot.now}
                shown={snapshot.shown[card.id]}
                target={snapshot.targets[card.id] ?? null}
                dismissTarget={snapshot.dismissTargets[card.id] ?? null}
                dismissPending={snapshot.pendingDismiss?.cardId === card.id}
                dismissing={snapshot.dismissingCardId === card.id}
                ownReply={snapshot.ownReplies[card.id] ?? ''}
                dropdownOpen={snapshot.openDropdownCardId === card.id}
                selected={snapshot.selectedCardId === card.id}
                density={snapshot.density}
                situationExpanded={snapshot.situationExpanded[card.id] === card.revision}
                onToggleSituationExpanded={() => controller.toggleSituationExpanded(card.id)}
                duplicates={snapshot.duplicates[card.id] ?? null}
                duplicatesQuestionless={cockpitCardQuestionOf(card) === null}
                onToggleDuplicates={() => controller.toggleDuplicates(card.id)}
                onSelect={() => controller.selectCard(card.id)}
                onOpenDetails={() => openCardDetails(card.id)}
                onToggleDropdown={() =>
                  controller.openDropdown(snapshot.openDropdownCardId === card.id ? null : card.id)
                }
                onShowOption={(optionId) => controller.showOption(card.id, optionId)}
                onShowOwnReply={() => controller.showOwnReply(card.id)}
                onOwnReplyChange={(text) => controller.setOwnReply(card.id, text)}
                onRequestConfirm={() => controller.requestConfirm(card.id)}
                confirmPending={pendingCardId === card.id}
                sendCountdown={countdownFor(card.id)}
                confirming={confirmingCardId === card.id}
                outcome={outcomeFor(card.id)}
                onConfirm={() => void controller.confirm()}
                onCancelConfirm={() => controller.cancelConfirm()}
                onRequestDismiss={() => controller.requestDismiss(card.id)}
                onConfirmDismiss={() => void controller.confirmDismiss()}
                onCancelDismiss={() => controller.cancelDismiss()}
                onResendFeedback={() => void controller.resendFeedback(card.id)}
                resendingFeedback={snapshot.resendingFeedbackCardId === card.id}
                feedbackResendError={
                  snapshot.feedbackResendError?.cardId === card.id
                    ? snapshot.feedbackResendError.message
                    : null
                }
              />
            ))}
          </div>

          {/* The page variant's Details drawer: a floating layer over the cards — a bottom sheet
              pinned to the phone's bottom edge, a centred card on a wide screen. The column
              variant never reaches this branch — its Details is pushed in above. */}
          {detailsCard !== null && (
            <div
              data-testid="cockpit-card-details-layer"
              data-drawer={isMobile ? 'true' : 'false'}
              className={cn(
                'fixed inset-0 z-40 flex justify-center bg-black/30',
                isMobile ? 'items-end p-0' : 'items-center p-2',
              )}
            >
              <CockpitCardDetails
                drawer={isMobile}
                card={detailsCard}
                now={snapshot.now}
                brief={snapshot.briefs[detailsCard.id]}
                onRetryBrief={() => controller.loadBrief(detailsCard.id)}
                onClose={() => controller.closeDetails()}
                shown={snapshot.shown[detailsCard.id]}
                ownReply={snapshot.ownReplies[detailsCard.id] ?? ''}
                onShowOption={(optionId: string) => controller.showOption(detailsCard.id, optionId)}
                onShowOwnReply={() => controller.showOwnReply(detailsCard.id)}
                onOwnReplyChange={(text: string) => controller.setOwnReply(detailsCard.id, text)}
                target={snapshot.targets[detailsCard.id] ?? null}
                onRequestConfirm={() => controller.requestConfirm(detailsCard.id)}
                confirmPending={pendingCardId === detailsCard.id}
                sendCountdown={countdownFor(detailsCard.id)}
                confirming={confirmingCardId === detailsCard.id}
                confirmOutcome={outcomeFor(detailsCard.id)}
                onConfirm={() => void controller.confirm()}
                onCancelConfirm={() => controller.cancelConfirm()}
                dismissTarget={snapshot.dismissTargets[detailsCard.id] ?? null}
                dismissPending={snapshot.pendingDismiss?.cardId === detailsCard.id}
                dismissing={snapshot.dismissingCardId === detailsCard.id}
                dismissNotice={
                  snapshot.dismissNotice?.cardId === detailsCard.id
                    ? snapshot.dismissNotice
                    : null
                }
                onRequestDismiss={() => controller.requestDismiss(detailsCard.id)}
                onConfirmDismiss={() => void controller.confirmDismiss()}
                onCancelDismiss={() => controller.cancelDismiss()}
                onOpenConversation={
                  onOpenConversation === undefined
                    ? undefined
                    : (sessionId: string) => onOpenConversation(detailsCard, sessionId)
                }
                openedInSession={openedCardId === detailsCard.id}
                startConversation={startConversationView(detailsCard)}
              />
            </div>
          )}
        </>
      )}

    </section>
  );
}
