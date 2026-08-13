import React from 'react';
import { Info, Shield, Smartphone, Wifi } from 'lucide-react';
import './MobileAbout.css';

export default function MobileAbout() {
  return (
    <div className="mobile-about">
      <div className="mobile-about__hero">
        <img src="/syscom-iot-logo.png" alt="" className="mobile-about__logo" />
        <h2>SYSCOM IoT Mobile</h2>
        <p>Versión {import.meta.env.VITE_APP_VERSION || '1.0.0'}</p>
      </div>

      <ul className="mobile-about__features">
        <li>
          <Smartphone size={20} aria-hidden />
          <div>
            <strong>Tablero por dispositivo</strong>
            <span>Visualice widgets, gráficos y downlinks configurados en el panel web.</span>
          </div>
        </li>
        <li>
          <Wifi size={20} aria-hidden />
          <div>
            <strong>Tiempo casi real</strong>
            <span>Telemetría actualizada desde su servidor SYSCOM IoT.</span>
          </div>
        </li>
        <li>
          <Shield size={20} aria-hidden />
          <div>
            <strong>Acceso seguro</strong>
            <span>Misma cuenta y permisos que en la plataforma web.</span>
          </div>
        </li>
        <li>
          <Info size={20} aria-hidden />
          <div>
            <strong>Soporte</strong>
            <span>Configure el tablero BSD en Dispositivos → Dashboard desde el navegador.</span>
          </div>
        </li>
      </ul>
    </div>
  );
}
