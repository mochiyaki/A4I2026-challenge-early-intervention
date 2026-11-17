import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bus,
  Car,
  ExternalLink,
  KeyRound,
  MapPin,
  Maximize2,
  Navigation,
} from 'lucide-react';
import {
  buildGoogleMapsEmbedUrl,
  loadGoogleMapsSdk,
  type GoogleMapsRuntime,
} from '../services/googleMapsService';
import type { ClinicMapPayload, MapStopItem } from '../types';
import { triggerCausalHaptic } from '../utils/applePhysics';

interface ClinicLocationMapCardProps {
  payload: ClinicMapPayload;
  googleMapsApiKey: string;
  compact?: boolean;
  onOpenApiModal?: () => void;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const ClinicLocationMapCard: React.FC<ClinicLocationMapCardProps> = ({
  payload,
  googleMapsApiKey,
  compact = false,
  onOpenApiModal,
}) => {
  const [selectedStopId, setSelectedStopId] = useState<string>(
    payload.focusedStopId
  );
  const [sdkReady, setSdkReady] = useState<boolean>(false);
  const [sdkError, setSdkError] = useState<string | null>(null);

  const mapCanvasRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<{
    setCenter: (pos: { lat: number; lng: number }) => void;
    panTo: (pos: { lat: number; lng: number }) => void;
    setZoom: (zoom: number) => void;
    fitBounds: (bounds: unknown, padding?: number) => void;
  } | null>(null);
  const googleRef = useRef<GoogleMapsRuntime | null>(null);

  useEffect(() => {
    setSelectedStopId(payload.focusedStopId);
  }, [payload.focusedStopId, payload.title]);

  const activeStop: MapStopItem = useMemo(() => {
    return (
      payload.stops.find((s) => s.id === selectedStopId) ?? payload.stops[0]
    );
  }, [payload.stops, selectedStopId]);

  /* Load Google Maps JavaScript SDK when an API key is configured */
  useEffect(() => {
    const trimmedKey = googleMapsApiKey.trim();
    if (!trimmedKey) {
      setSdkReady(false);
      setSdkError(null);
      return;
    }

    let cancelled = false;
    setSdkError(null);

    loadGoogleMapsSdk(trimmedKey)
      .then((g) => {
        if (cancelled) return;
        googleRef.current = g;
        setSdkReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setSdkReady(false);
        setSdkError(
          err instanceof Error
            ? err.message
            : 'Google Maps JS SDK unavailable; showing Google Maps coordinate embed.'
        );
      });

    return () => {
      cancelled = true;
    };
  }, [googleMapsApiKey]);

  /* Render multi-pin Google Maps JS SDK vector map + route polyline when SDK is active */
  useEffect(() => {
    if (!sdkReady || !googleRef.current || !mapCanvasRef.current) return;
    const g = googleRef.current;

    const map = new g.maps.Map(mapCanvasRef.current, {
      center: { lat: activeStop.latitude, lng: activeStop.longitude },
      zoom: compact ? 10 : 11,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: !compact,
    });
    mapInstanceRef.current = map;

    const infoWindow = new g.maps.InfoWindow();
    const bounds = new g.maps.LatLngBounds();
    const pathCoords: { lat: number; lng: number }[] = [];

    const markers: {
      stop: MapStopItem;
      marker: InstanceType<GoogleMapsRuntime['maps']['Marker']>;
    }[] = [];

    payload.stops.forEach((stop) => {
      const pos = { lat: stop.latitude, lng: stop.longitude };
      bounds.extend(pos);
      pathCoords.push(pos);

      const isFocused = stop.id === selectedStopId;
      const marker = new g.maps.Marker({
        position: pos,
        map,
        title: `${stop.shortRole}: ${stop.name}`,
        label: {
          text: stop.badgeText,
          color: '#FFFFFF',
          fontWeight: '700',
          fontSize: '11px',
        },
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: isFocused ? 13 : 10.5,
          fillColor: stop.isHomeOrigin
            ? '#047857'
            : isFocused
              ? '#0284C7'
              : '#0F172A',
          fillOpacity: 1,
          strokeColor: '#FFFFFF',
          strokeWeight: 2.2,
        },
      });

      marker.addListener('click', () => {
        setSelectedStopId(stop.id);
        const synBadge = stop.isSynthetic
          ? `<div style="font-size:11px;color:#0369A1;font-weight:600;margin-top:2px;">100% [Synthetic] CareNode (${escapeHtml(stop.providerId || '')})</div>`
          : `<div style="font-size:11px;color:#047857;font-weight:600;margin-top:2px;">US Census ACS Tract Centroid</div>`;
        infoWindow.setContent(
          `<div style="font-family:system-ui,sans-serif;padding:2px 4px;max-width:230px;color:#0F172A;">
            <div style="font-weight:700;font-size:13px;">${escapeHtml(stop.name)}</div>
            ${synBadge}
            <div style="font-size:12px;color:#475569;margin-top:4px;">${escapeHtml(stop.address)}, ${escapeHtml(stop.city)}</div>
            <div style="font-size:11.5px;color:#0F172A;margin-top:4px;font-weight:600;">${stop.isHomeOrigin ? 'Origin (0 km)' : `${stop.distanceFromHomeKm} km from home`}</div>
          </div>`
        );
        infoWindow.open({ map, anchor: marker });
      });

      markers.push({ stop, marker });
    });

    const polyline = new g.maps.Polyline({
      path: pathCoords,
      geodesic: true,
      strokeColor: '#0284C7',
      strokeOpacity: 0.88,
      strokeWeight: 3.5,
      icons: [
        {
          icon: {
            path: g.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 3,
            strokeColor: '#0284C7',
          },
          offset: '55%',
        },
      ],
    });
    polyline.setMap(map);

    if (payload.stops.length > 1) {
      map.fitBounds(bounds, compact ? 32 : 48);
    }

    return () => {
      markers.forEach((m) => m.marker.setMap(null));
      polyline.setMap(null);
      infoWindow.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady, payload]);

  /* Pan smoothly when user switches selected stop in JS SDK mode */
  const handleSelectStop = (stop: MapStopItem) => {
    triggerCausalHaptic(3);
    setSelectedStopId(stop.id);
    if (sdkReady && mapInstanceRef.current) {
      mapInstanceRef.current.panTo({
        lat: stop.latitude,
        lng: stop.longitude,
      });
      mapInstanceRef.current.setZoom(13);
    }
  };

  const handleFitRoute = () => {
    if (!sdkReady || !googleRef.current || !mapInstanceRef.current) return;
    const bounds = new googleRef.current.maps.LatLngBounds();
    payload.stops.forEach((s) =>
      bounds.extend({ lat: s.latitude, lng: s.longitude })
    );
    mapInstanceRef.current.fitBounds(bounds, compact ? 32 : 48);
  };

  const embedUrl = buildGoogleMapsEmbedUrl(
    activeStop.latitude,
    activeStop.longitude,
    activeStop.isHomeOrigin ? 11 : 13
  );

  const mapHeightClass = compact ? 'h-[215px]' : 'h-[310px] sm:h-[350px]';

  return (
    <div className="rounded-[12px] bg-[var(--pm-card)] border border-[var(--pm-border)] overflow-hidden text-[var(--pm-ink)] shadow-2xs">
      {/* 1. Header Bar */}
      <div className="px-3.5 py-2.5 bg-[var(--pm-surface)] border-b border-[var(--pm-border)] flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <MapPin
              aria-hidden="true"
              className="w-3.5 h-3.5 text-[var(--pm-accent)] shrink-0"
            />
            <span
              className="text-[13px] font-semibold text-[var(--pm-ink)] truncate"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {payload.title}
            </span>
          </div>
          <div className="text-[11.5px] text-[var(--pm-muted)] truncate">
            {payload.subtitle}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className="pm-badge text-[11px]">
            {payload.travelMode === 'transit' ? (
              <>
                <Bus aria-hidden="true" className="w-3 h-3 text-[var(--pm-warning)]" />
                <span>Transit / NEMT</span>
              </>
            ) : (
              <>
                <Car aria-hidden="true" className="w-3 h-3 text-[var(--pm-accent)]" />
                <span>Driving</span>
              </>
            )}
          </span>

          {sdkReady && payload.stops.length > 1 && (
            <button
              type="button"
              onClick={handleFitRoute}
              title="Fit all route stops on map"
              className="min-h-[30px] px-2 py-0.5 rounded-[6px] bg-[var(--pm-card)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border-strong)] text-[11px] font-semibold text-[var(--pm-ink)] inline-flex items-center gap-1 cursor-pointer"
            >
              <Maximize2 aria-hidden="true" className="w-3 h-3" />
              <span>Fit route</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Interactive Stop Selector Strip */}
      {payload.stops.length > 1 && (
        <div
          role="tablist"
          aria-label="Select clinic or home stop on Google Map"
          className="px-3 py-2 bg-[var(--pm-card)] border-b border-[var(--pm-border)] flex gap-1.5 overflow-x-auto no-scrollbar"
        >
          {payload.stops.map((stop) => {
            const active = stop.id === activeStop.id;
            return (
              <button
                key={stop.id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => handleSelectStop(stop)}
                className={`shrink-0 min-h-[34px] px-2.5 py-1 rounded-[7px] text-[11.5px] font-semibold border inline-flex items-center gap-1.5 cursor-pointer touch-manipulation transition-colors ${
                  active
                    ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)] text-[var(--pm-accent)]'
                    : 'bg-[var(--pm-surface)] border-[var(--pm-border)] text-[var(--pm-muted)] hover:text-[var(--pm-ink)]'
                }`}
                style={{ fontFamily: 'var(--font-display)' }}
              >
                <span
                  className={`w-4 h-4 rounded-full text-[10px] font-mono-code font-bold flex items-center justify-center ${
                    stop.isHomeOrigin
                      ? 'bg-[var(--pm-compliant)] text-white'
                      : active
                        ? 'bg-[var(--pm-cta-bg)] text-white'
                        : 'bg-[var(--pm-border-strong)] text-white'
                  }`}
                >
                  {stop.badgeText}
                </span>
                <span>{stop.shortRole}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 3. Live Google Map Viewport (JS SDK Vector Map OR Interactive Google Maps Coordinate Embed) */}
      <div className={`relative w-full ${mapHeightClass} bg-[var(--pm-surface)]`}>
        {sdkReady ? (
          <div
            ref={mapCanvasRef}
            className="w-full h-full"
            aria-label={`Interactive Google Map showing ${payload.title}`}
          />
        ) : (
          <iframe
            key={`${activeStop.id}-${activeStop.latitude}-${activeStop.longitude}`}
            title={`Google Map centered on ${activeStop.name} in ${activeStop.city}`}
            src={embedUrl}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className="w-full h-full border-0"
          />
        )}
      </div>

      {/* 4. Active Pin Readout + Google Maps Multi-Stop Directions Action */}
      <div className="p-3.5 space-y-2.5 bg-[var(--pm-card)] border-t border-[var(--pm-border)] text-[12.5px]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-[13.5px] text-[var(--pm-ink)]" style={{ fontFamily: 'var(--font-display)' }}>
                {activeStop.name}
              </span>
              {activeStop.isSynthetic && (
                <span className="font-mono-code text-[10.5px] px-1.5 py-0.5 rounded-[4px] bg-[var(--pm-surface)] border border-[var(--pm-border)] text-[var(--pm-muted)]">
                  [Synthetic] {activeStop.providerId}
                </span>
              )}
            </div>
            <div className="text-[var(--pm-muted)]">
              {activeStop.address}, {activeStop.city} ({activeStop.latitude.toFixed(4)},{' '}
              {activeStop.longitude.toFixed(4)})
            </div>
          </div>

          <div className="text-right font-mono-code shrink-0">
            <div className="font-semibold text-[var(--pm-accent)]">
              {activeStop.isHomeOrigin
                ? '0.0 km (Origin)'
                : `${activeStop.distanceFromHomeKm} km from home`}
            </div>
            {typeof activeStop.cumulativeDays === 'number' && (
              <div className="text-[11px] text-[var(--pm-muted)]">
                Target: Day {activeStop.cumulativeDays}
              </div>
            )}
          </div>
        </div>

        {sdkError && (
          <div className="text-[11.5px] text-[var(--pm-warning)]">
            {sdkError}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--pm-border)]">
          <div className="flex flex-wrap items-center gap-1.5">
            {activeStop.acceptsMedicaid && (
              <span className="pm-badge pm-badge-compliant text-[11px]">
                $0 Medicaid
              </span>
            )}
            {activeStop.bilingual && (
              <span className="pm-badge pm-badge-accent text-[11px]">
                Bilingual staffed
              </span>
            )}
            {!sdkReady && onOpenApiModal && (
              <button
                type="button"
                onClick={onOpenApiModal}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--pm-muted)] hover:text-[var(--pm-accent)] cursor-pointer transition-colors"
              >
                <KeyRound aria-hidden="true" className="w-3 h-3" />
                <span>{googleMapsApiKey ? 'Update Maps JS key' : 'Optional Maps JS key'}</span>
              </button>
            )}
          </div>

          <a
            href={payload.directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 min-h-[34px] px-3 py-1 rounded-[7px] bg-[var(--pm-cta-bg)] hover:bg-[var(--pm-cta-hover)] text-white text-[12px] font-semibold no-underline transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            <Navigation aria-hidden="true" className="w-3 h-3" />
            <span>Google Maps directions</span>
            <ExternalLink aria-hidden="true" className="w-3 h-3 opacity-80" />
          </a>
        </div>
      </div>
    </div>
  );
};
