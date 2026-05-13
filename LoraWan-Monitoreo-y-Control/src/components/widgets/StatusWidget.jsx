import React from 'react';
import { motion as Motion } from 'framer-motion';
import { Radio } from 'lucide-react';

const StatusWidget = ({ title, status, lastSeen }) => {
  const isOnline = status.toLowerCase() === 'online';
  
  return (
    <Motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="card glass status-widget"
    >
      <div className="widget-header">
        <span className="widget-title">{title}</span>
        <Radio size={16} className={isOnline ? 'pulse' : ''} style={{ color: isOnline ? 'var(--success)' : 'var(--danger)' }} />
      </div>
      <div className="status-content">
        <div className="status-badge" style={{ backgroundColor: isOnline ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
          <span className="status-text" style={{ color: isOnline ? 'var(--success)' : 'var(--danger)' }}>
            {status}
          </span>
        </div>
        <div className="last-seen">
          Last seen: {lastSeen}
        </div>
      </div>
    </Motion.div>
  );
};

export default StatusWidget;
