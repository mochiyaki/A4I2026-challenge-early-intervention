import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  Bus,
  Car,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  GripHorizontal,
  KeyRound,
  Mail,
  MapPin,
  Maximize2,
  Minimize2,
  Navigation,
  Phone,
  Stethoscope,
} from 'lucide-react';
import {
  buildGoogleMapsEmbedUrl,
  loadGoogleMapsSdk,
  lookupGooglePlacesContact,
  type GoogleMapsRuntime,
  type GooglePlaceContactResult,
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
  const [placesContact, setPlacesContact] =
    useState<GooglePlaceContactResult | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const defaultMapHeight = compact ? 255 : 365;
  const [mapHeightPx, setMapHeightPx] = useState<number>(defaultMapHeight);
  const [isDraggingHeight, setIsDraggingHeight] = useState<boolean>(false);
  const dragStartYRef = useRef<number>(0);
  const dragStartHRef = useRef<number>(defaultMapHeight);

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

  const handleCopyText = (key: string, value: string) => {
    triggerCausalHaptic(5);
    navigator.clipboard.writeText(value);
    setCopiedField(key);
    window.setTimeout(() => setCopiedField(null), 1700);
  };

  /* Load Google Maps JavaScript SDK (+ Places API) when an API key is configured */
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
        const phoneLine = stop.syntheticPhone
          ? `<div style="font-size:11.5px;color:#0F172A;margin-top:3px;">Intake: <strong>${escapeHtml(stop.syntheticPhone)}</strong> [Synthetic]</div>`
          : '';
        infoWindow.setContent(
          `<div style="font-family:system-ui,sans-serif;padding:2px 4px;max-width:245px;color:#0F172A;">
            <div style="font-weight:700;font-size:13px;">${escapeHtml(stop.name)}</div>
            ${synBadge}
            <div style="font-size:12px;color:#475569;margin-top:4px;">${escapeHtml(stop.address)}, ${escapeHtml(stop.city)}</div>
            ${phoneLine}
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

  /* Optional Google Places API Regional Early Intervention Office Lookup when SDK is active */
  useEffect(() => {
    if (!sdkReady || !googleRef.current || !mapInstanceRef.current) {
      setPlacesContact(null);
      return;
    }

    let cancelled = false;
    const query = `${payload.statePartCHotline.programName} ${activeStop.city}`;
    lookupGooglePlacesContact(
      googleRef.current,
      mapInstanceRef.current,
      query,
      { lat: activeStop.latitude, lng: activeStop.longitude }
    ).then((res) => {
      if (!cancelled) setPlacesContact(res);
    });

    return () => {
      cancelled = true;
    };
  }, [
    sdkReady,
    activeStop.city,
    activeStop.latitude,
    activeStop.longitude,
    payload.statePartCHotline.programName,
  ]);

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

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartYRef.current = e.clientY;
    dragStartHRef.current = mapHeightPx;
    setIsDraggingHeight(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingHeight) return;
    const dy = e.clientY - dragStartYRef.current;
    const next = Math.min(
      720,
      Math.max(190, Math.round(dragStartHRef.current + dy))
    );
    setMapHeightPx(next);
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingHeight(false);
  };

  const formattedContactBlock = [
    `${activeStop.name}${activeStop.isSynthetic ? ` [Synthetic ${activeStop.providerId}]` : ''}`,
    `Address: ${activeStop.address}, ${activeStop.city} (${activeStop.countyName})`,
    activeStop.syntheticPhone
      ? `Clinic Intake Phone: ${activeStop.syntheticPhone} [Synthetic demo line]`
      : null,
    activeStop.intakeEmail ? `e-Referral Intake: ${activeStop.intakeEmail}` : null,
    activeStop.hoursText ? `Hours: ${activeStop.hoursText}` : null,
    `Official ${payload.stateCode} Part C Helpline: ${payload.statePartCHotline.programName} — ${payload.statePartCHotline.tollFreePhone}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="rounded-[12px] bg-[var(--pm-card)] border border-[var(--pm-border)] overflow-hidden text-[var(--pm-ink)] shadow-2xs pm-pane-cq">
      {/* 1. Header Bar */}
      <div className="px-3.5 py-2.5 bg-[var(--pm-surface)] border-b border-[var(--pm-border)] flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <MapPin
              aria-hidden="true"
              className="w-3.5 h-3.5 text-[var(--pm-accent)] shrink-0"
            />
            <span
              className="text-[13px] font-semibold text-[var(--pm-ink)]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {payload.title}
            </span>
          </div>
          <div className="text-[11.5px] text-[var(--pm-muted)]">
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

          <button
            type="button"
            onClick={() => {
              triggerCausalHaptic(3);
              setMapHeightPx((h) =>
                h > defaultMapHeight + 60
                  ? defaultMapHeight
                  : defaultMapHeight + 160
              );
            }}
            title="Toggle taller Google Map frame"
            className="min-h-[30px] px-2 py-0.5 rounded-[6px] bg-[var(--pm-card)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border-strong)] text-[11px] font-semibold text-[var(--pm-ink)] inline-flex items-center gap-1 cursor-pointer"
          >
            {mapHeightPx > defaultMapHeight + 60 ? (
              <>
                <Minimize2 aria-hidden="true" className="w-3 h-3" />
                <span>Compact</span>
              </>
            ) : (
              <>
                <Maximize2 aria-hidden="true" className="w-3 h-3" />
                <span>Taller</span>
              </>
            )}
          </button>

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
      <div
        style={{ height: `${mapHeightPx}px` }}
        className="relative w-full bg-[var(--pm-surface)]"
      >
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
            className={`w-full h-full border-0 ${
              isDraggingHeight ? 'pointer-events-none' : ''
            }`}
          />
        )}
      </div>

      {/* Vertical Drag-to-Resize Handle for Map Viewport */}
      <div
        role="separator"
        tabIndex={0}
        aria-label="Drag to resize Google Map height (double-click to reset)"
        aria-orientation="horizontal"
        aria-valuemin={190}
        aria-valuemax={720}
        aria-valuenow={mapHeightPx}
        data-dragging={isDraggingHeight}
        title="Drag up or down to resize map height · Double-click to reset"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        onDoubleClick={() => setMapHeightPx(defaultMapHeight)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setMapHeightPx((h) => Math.min(720, h + 28));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setMapHeightPx((h) => Math.max(190, h - 28));
          }
        }}
        className="pm-resize-bar-y no-print"
      >
        <GripHorizontal aria-hidden="true" className="w-4 h-3.5" />
      </div>

      {/* 4. Clinic Contact & Direct Intake Directory Under the Map */}
      <div className="p-3.5 sm:p-4 space-y-3 bg-[var(--pm-card)] border-t border-[var(--pm-border)] text-[12.5px]">
        {/* Selected Stop Title, Address & Distance */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="font-semibold text-[14px] text-[var(--pm-ink)]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {activeStop.name}
              </span>
              {activeStop.isSynthetic && (
                <span className="font-mono-code text-[10.5px] px-1.5 py-0.5 rounded-[4px] bg-[var(--pm-surface)] border border-[var(--pm-border)] text-[var(--pm-muted)]">
                  [Synthetic] {activeStop.providerId}
                </span>
              )}
            </div>
            <div className="text-[var(--pm-muted)]">
              {activeStop.address}, {activeStop.city} · {activeStop.countyName} (
              {activeStop.latitude.toFixed(4)}, {activeStop.longitude.toFixed(4)})
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right font-mono-code">
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

            <button
              type="button"
              onClick={() => handleCopyText('all', formattedContactBlock)}
              title="Copy clinic address, phone, e-Portal email & Part C helpline"
              className="min-h-[32px] px-2.5 py-1 rounded-[7px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border-strong)] text-[11.5px] font-semibold text-[var(--pm-ink)] inline-flex items-center gap-1 cursor-pointer transition-colors"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {copiedField === 'all' ? (
                <>
                  <Check
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-[var(--pm-compliant)]"
                  />
                  <span>Copied info</span>
                </>
              ) : (
                <>
                  <Copy aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-muted)]" />
                  <span>Copy contact</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Structured Clinic Contact Details (Phone, e-Referral Email, Hours, Specialty & Waitlist) */}
        {!activeStop.isHomeOrigin ? (
          <div className="pm-grid-checks pt-1">
            {/* Phone & Intake Channel */}
            <div className="p-2.5 rounded-[9px] bg-[var(--pm-surface)] border border-[var(--pm-border)] space-y-1.5">
              <div className="flex items-center justify-between gap-1.5">
                <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--pm-muted)]">
                  <Phone aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-accent)]" />
                  <span>Clinic intake line</span>
                </span>
                {activeStop.syntheticPhone && (
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText('phone', activeStop.syntheticPhone || '')
                    }
                    className="text-[11px] font-semibold text-[var(--pm-accent)] hover:underline cursor-pointer"
                  >
                    {copiedField === 'phone' ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              <div className="font-mono-code font-semibold text-[13px] text-[var(--pm-ink)]">
                {activeStop.syntheticPhone}{' '}
                <span className="text-[10.5px] font-normal text-[var(--pm-muted)]">
                  [Synthetic 555]
                </span>
              </div>
              {activeStop.intakeEmail && (
                <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-[var(--pm-border)]">
                  <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--pm-text)] break-all font-mono-code">
                    <Mail aria-hidden="true" className="w-3 h-3 shrink-0 text-[var(--pm-muted)]" />
                    <span>{activeStop.intakeEmail}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText('email', activeStop.intakeEmail || '')
                    }
                    className="text-[11px] font-semibold text-[var(--pm-accent)] hover:underline shrink-0 cursor-pointer"
                  >
                    {copiedField === 'email' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              {activeStop.intakeChannelLabel && (
                <div className="text-[11px] text-[var(--pm-muted)]">
                  Channel: <strong className="font-semibold text-[var(--pm-ink)]">{activeStop.intakeChannelLabel}</strong>
                </div>
              )}
            </div>

            {/* Clinic Hours, Specialty & Live Capacity */}
            <div className="p-2.5 rounded-[9px] bg-[var(--pm-surface)] border border-[var(--pm-border)] space-y-1.5">
              {activeStop.hoursText && (
                <div className="flex items-start gap-1.5 text-[11.5px] text-[var(--pm-ink)]">
                  <Clock
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-[var(--pm-accent)] shrink-0 mt-0.5"
                  />
                  <span>{activeStop.hoursText}</span>
                </div>
              )}

              {activeStop.specialty && (
                <div className="flex items-start gap-1.5 text-[11.5px] text-[var(--pm-muted)]">
                  <Stethoscope
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-[var(--pm-muted)] shrink-0 mt-0.5"
                  />
                  <span>{activeStop.specialty}</span>
                </div>
              )}

              {typeof activeStop.medianInternalWaitDays === 'number' && (
                <div className="text-[11px] font-mono-code text-[var(--pm-muted)] pt-1 border-t border-[var(--pm-border)] flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Internal wait:{' '}
                    <strong className="text-[var(--pm-ink)]">
                      {activeStop.medianInternalWaitDays}d
                    </strong>
                  </span>
                  {typeof activeStop.monthlySlotCapacity === 'number' && (
                    <span>
                      Capacity:{' '}
                      <strong className="text-[var(--pm-ink)]">
                        {activeStop.monthlySlotCapacity}/mo
                      </strong>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="p-2.5 rounded-[9px] bg-[var(--pm-surface)] border border-[var(--pm-border)] text-[12px] text-[var(--pm-muted)]">
            {activeStop.hoursText} · {activeStop.intakeChannelLabel}. Select stops{' '}
            <strong className="text-[var(--pm-ink)]">1–4</strong> above to view each clinic&apos;s direct intake phone, e-Portal email, hours, and specialty.
          </div>
        )}

        {/* Official Public State Part C Lead Agency Referral Helpline (+ Live Google Places match if active) */}
        <div className="p-2.5 rounded-[9px] bg-[var(--pm-compliant-soft)] border border-[var(--pm-compliant-border)] flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <div className="space-y-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 font-semibold text-[var(--pm-ink)]">
              <Building2
                aria-hidden="true"
                className="w-3.5 h-3.5 text-[var(--pm-compliant)] shrink-0"
              />
              <span>{payload.statePartCHotline.programName}</span>
              <span className="font-mono-code text-[10.5px] text-[var(--pm-compliant)]">
                [Official State Helpline]
              </span>
            </div>
            {placesContact?.formattedPhone && (
              <div className="text-[11.5px] text-[var(--pm-muted)]">
                Google Places verified match:{' '}
                <strong className="text-[var(--pm-ink)]">
                  {placesContact.placeName}
                </strong>{' '}
                · {placesContact.formattedPhone}
                {placesContact.openNowLabel ? ` · ${placesContact.openNowLabel}` : ''}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href={`tel:${payload.statePartCHotline.tollFreePhone.replace(/[^0-9+]/g, '')}`}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] bg-[var(--pm-card)] border border-[var(--pm-border-strong)] font-mono-code font-semibold text-[12px] text-[var(--pm-ink)] hover:border-[var(--pm-accent)] no-underline transition-colors"
            >
              <Phone aria-hidden="true" className="w-3 h-3 text-[var(--pm-compliant)]" />
              <span>{payload.statePartCHotline.tollFreePhone}</span>
            </a>
            <a
              href={payload.statePartCHotline.officialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-[6px] bg-[var(--pm-card)] border border-[var(--pm-border)] font-semibold text-[11.5px] text-[var(--pm-accent)] hover:underline no-underline"
            >
              <Globe aria-hidden="true" className="w-3 h-3" />
              <span>State portal</span>
            </a>
          </div>
        </div>

        {sdkError && (
          <div className="text-[11.5px] text-[var(--pm-warning)]">
            {sdkError}
          </div>
        )}

        {/* Footer Badges + Optional Maps Key + Google Maps Turn-by-Turn Directions */}
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
            {activeStop.partCVendorEnrolled && (
              <span className="pm-badge text-[11px]">Part C enrolled</span>
            )}
            {!sdkReady && onOpenApiModal && (
              <button
                type="button"
                onClick={onOpenApiModal}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--pm-muted)] hover:text-[var(--pm-accent)] cursor-pointer transition-colors"
              >
                <KeyRound aria-hidden="true" className="w-3 h-3" />
                <span>
                  {googleMapsApiKey
                    ? 'Update Maps JS key'
                    : 'Optional Maps JS key'}
                </span>
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
