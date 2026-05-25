import React from 'react';

/**
 * Interruptor skeuomórfico (marco metálico, pista ON/OFF, perilla cepillada).
 *
 * @param {{
 *   isOn: boolean;
 *   busy?: boolean;
 *   disabled?: boolean;
 *   onClick?: () => void;
 *   className?: string;
 * }} props
 */
export default function BsdRealisticSwitch({
  isOn,
  busy = false,
  disabled = false,
  onClick,
  className = '',
}) {
  const trackClass = [
    'bsd-switch-3d',
    isOn ? 'is-on' : 'is-off',
    busy ? 'is-busy' : '',
    disabled ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={['bsd-switch-panel', 'bsd-switch-panel--compact', className].filter(Boolean).join(' ')}>
      <div className="bsd-switch-panel__switch-wrap">
        <button
          type="button"
          className={trackClass}
          onClick={onClick}
          disabled={disabled}
          aria-pressed={isOn}
          aria-busy={busy}
          aria-label={busy ? 'Enviando' : isOn ? 'Apagar' : 'Encender'}
        >
          <span className="bsd-switch-3d__frame" aria-hidden>
            <span className="bsd-switch-3d__track">
              <span className="bsd-switch-3d__mark bsd-switch-3d__mark--on">ON</span>
              <span className="bsd-switch-3d__mark bsd-switch-3d__mark--off">OFF</span>
              <span className="bsd-switch-3d__knob">
                <span className="bsd-switch-3d__knob-shine" />
              </span>
            </span>
          </span>
        </button>
        {busy ? (
          <div className="bsd-switch-sending-toast" role="status" aria-live="polite">
            Enviando
          </div>
        ) : null}
      </div>
    </div>
  );
}
