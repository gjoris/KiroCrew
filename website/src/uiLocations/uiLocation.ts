/**
 * The render-site half of a registered UI location (see `./descriptors.ts`).
 *
 * Spread it onto the element a person actually sees and clicks:
 *
 *     <div role="button" {...uiLocation('chat.older-sessions')}>…</div>
 *
 * It only adds a `data-ui-location` attribute. The find_ui generator reads the
 * spread statically to prove where the control is drawn and which catalog key
 * its label comes from; at runtime the attribute is inert. A component that
 * receives it must forward unknown props to its root element.
 */
import type { UiLocationId } from './descriptors'

export const UI_LOCATION_ATTR = 'data-ui-location'

export function uiLocation(id: UiLocationId): { 'data-ui-location': UiLocationId } {
  return { [UI_LOCATION_ATTR]: id } as { 'data-ui-location': UiLocationId }
}
