import React from 'react';
import { motion as Motion } from 'framer-motion';

const CircularLevelWidget = ({ title, value, unit }) => {
  const parsedValue = parseFloat(value);
  const hasValue = Number.isFinite(parsedValue);
  const numericValue = hasValue ? parsedValue : 0;
  
  // Example scale 0 - 5 meters
  const min = 0;
  const max = 5;
  const percentage = Math.max(0, Math.min(100, ((numericValue - min) / (max - min)) * 100));
  
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <Motion.div
      aria-label={title || 'Nivel'}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}
    >
      <div style={{ position: 'relative', width: '150px', height: '150px' }}>
        {/* Background Circle */}
        <svg fill="transparent" width="150" height="150" viewBox="0 0 150 150">
          <circle 
            stroke="var(--bg-secondary)" 
            strokeWidth="10" 
            cx="75" cy="75" r={radius} 
          />
          {/* Progress Circle (Level) */}
          <circle 
            stroke="var(--danger)" // Red color to match design
            strokeWidth="10" 
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            cx="75" cy="75" r={radius} 
            style={{ transition: 'stroke-dashoffset 0.5s ease-in-out', transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}
          />
        </svg>

        {/* Liquid Fill Effect (Simulated with a clipped div) */}
        <div style={{
          position: 'absolute',
          bottom: '20px',
          left: '20px',
          width: '110px',
          height: '110px',
          borderRadius: '50%',
          overflow: 'hidden',
          zIndex: 0
        }}>
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: `${percentage}%`,
            backgroundColor: 'var(--danger)',
            opacity: 0.8,
            transition: 'height 0.5s ease'
          }}></div>
        </div>

        {/* Text */}
        <div style={{ 
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', 
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          zIndex: 1
        }}>
          <h2 style={{ margin: 0, fontSize: '2rem', fontWeight: 700, color: percentage > 50 ? 'white' : 'var(--text-primary)'}}>
            {hasValue ? numericValue.toFixed(2) : '--'}
          </h2>
          <span style={{ fontSize: '0.9rem', color: percentage > 50 ? 'rgba(255,255,255,0.8)' : 'var(--text-secondary)' }}>
            {unit || 'Meter'}
          </span>
          {!hasValue && (
            <span style={{ marginTop: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Sin datos
            </span>
          )}
        </div>
      </div>
    </Motion.div>
  );
};

export default CircularLevelWidget;
