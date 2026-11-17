import { cleanOrgName, haversineKm } from '../engine/graphTriageEngine';
import type {
  CandidatePathway,
  CareNode,
  ClinicMapPayload,
  MapStopItem,
  ReferralIntakeInput,
  TractDemographic,
} from '../types';

const MAPS_KEY_STORAGE = 'a4i_google_maps_api_key';

/* Minimal ambient Google Maps JS SDK surface so we avoid external @types/google.maps dependency issues */
export interface GoogleMapsLatLngLiteral {
  lat: number;
  lng: number;
}

export interface GoogleMapsRuntime {
  maps: {
    Map: new (el: HTMLElement, opts: Record<string, unknown>) => {
      setCenter: (pos: GoogleMapsLatLngLiteral) => void;
      panTo: (pos: GoogleMapsLatLngLiteral) => void;
      setZoom: (zoom: number) => void;
      fitBounds: (bounds: unknown, padding?: number) => void;
    };
    Marker: new (opts: Record<string, unknown>) => {
      setMap: (map: unknown) => void;
      addListener: (event: string, handler: () => void) => void;
    };
    Polyline: new (opts: Record<string, unknown>) => {
      setMap: (map: unknown) => void;
    };
    InfoWindow: new (opts?: Record<string, unknown>) => {
      setContent: (html: string) => void;
      open: (opts: { map: unknown; anchor: unknown }) => void;
      close: () => void;
    };
    LatLngBounds: new () => {
      extend: (pos: GoogleMapsLatLngLiteral) => void;
    };
    SymbolPath: {
      CIRCLE: unknown;
      FORWARD_CLOSED_ARROW: unknown;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleMapsRuntime;
    gm_authFailure?: () => void;
  }
}

export function getSavedGoogleMapsApiKey(): string {
  if (typeof window === 'undefined') return '';
  return (
    window.localStorage.getItem(MAPS_KEY_STORAGE) ||
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ||
    ''
  ).trim();
}

export function saveGoogleMapsApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = apiKey.trim();
  if (trimmed) {
    window.localStorage.setItem(MAPS_KEY_STORAGE, trimmed);
  } else {
    window.localStorage.removeItem(MAPS_KEY_STORAGE);
  }
}

let activeLoaderPromise: Promise<GoogleMapsRuntime> | null = null;
let loadedWithKey: string | null = null;

/**
 * Dynamically loads the official Google Maps JavaScript API when an API key is provided,
 * handling `gm_authFailure` cleanly so invalid/restricted keys fall back gracefully.
 */
export function loadGoogleMapsSdk(apiKey: string): Promise<GoogleMapsRuntime> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    return Promise.reject(new Error('No Google Maps API key configured.'));
  }

  if (typeof window !== 'undefined' && window.google?.maps && loadedWithKey === cleanKey) {
    return Promise.resolve(window.google);
  }

  if (activeLoaderPromise && loadedWithKey === cleanKey) {
    return activeLoaderPromise;
  }

  // If key changed, remove previous script tag so user can test a new key live
  const existingScript = document.getElementById('pm-google-maps-sdk');
  if (existingScript && loadedWithKey !== cleanKey) {
    existingScript.remove();
    activeLoaderPromise = null;
  }

  loadedWithKey = cleanKey;
  activeLoaderPromise = new Promise<GoogleMapsRuntime>((resolve, reject) => {
    window.gm_authFailure = () => {
      activeLoaderPromise = null;
      reject(new Error('Google Maps API key authentication failed (check key restrictions or billing).'));
    };

    const script = document.createElement('script');
    script.id = 'pm-google-maps-sdk';
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cleanKey)}&v=weekly`;
    script.onload = () => {
      if (window.google?.maps) {
        resolve(window.google);
      } else {
        activeLoaderPromise = null;
        reject(new Error('Google Maps SDK loaded without google.maps namespace.'));
      }
    };
    script.onerror = () => {
      activeLoaderPromise = null;
      reject(new Error('Network error loading Google Maps JavaScript API.'));
    };
    document.head.appendChild(script);
  });

  return activeLoaderPromise;
}

/**
 * Builds a keyless Google Maps interactive embed URL centered on exact clinic coordinates.
 */
export function buildGoogleMapsEmbedUrl(
  latitude: number,
  longitude: number,
  zoom = 13
): string {
  const lat = latitude.toFixed(5);
  const lng = longitude.toFixed(5);
  return `https://maps.google.com/maps?q=${lat},${lng}&ll=${lat},${lng}&z=${zoom}&output=embed`;
}

/**
 * Builds a multi-stop Google Maps Directions URL from the child's home census tract
 * through the CareNode clinical pathway.
 */
export function buildGoogleMapsDirectionsUrl(
  originLat: number,
  originLng: number,
  destinationLat: number,
  destinationLng: number,
  waypoints: { lat: number; lng: number }[],
  travelMode: 'driving' | 'transit'
): string {
  const params = new URLSearchParams({
    api: '1',
    origin: `${originLat.toFixed(5)},${originLng.toFixed(5)}`,
    destination: `${destinationLat.toFixed(5)},${destinationLng.toFixed(5)}`,
    travelmode: travelMode,
  });
  if (waypoints.length > 0) {
    params.set(
      'waypoints',
      waypoints.map((w) => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join('|')
    );
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Builds a structured `ClinicMapPayload` for either the active 4-node pathway
 * or a single inspected CareNode clinic relative to the family's home census tract.
 */
export function buildClinicMapPayload(
  intake: ReferralIntakeInput,
  tract: TractDemographic,
  activePathway: CandidatePathway | null,
  fallbackNode?: CareNode | null,
  preferredFocus?: 'eval' | 'origin' | 'coordinator' | 'vendor' | 'home' | string
): ClinicMapPayload {
  const travelMode: 'driving' | 'transit' = intake.hasHouseholdVehicle
    ? 'driving'
    : 'transit';

  const homeStop: MapStopItem = {
    id: `home-${tract.census_tract_geoid}`,
    badgeText: 'H',
    shortRole: 'Home Tract',
    name: `${tract.county_name} Home Centroid`,
    address: `Census Tract ${tract.census_tract_geoid}`,
    city: tract.county_name,
    countyName: tract.county_name,
    latitude: tract.latitude,
    longitude: tract.longitude,
    distanceFromHomeKm: 0,
    isHomeOrigin: true,
    isSynthetic: false,
  };

  if (activePathway && activePathway.steps.length >= 4) {
    const roleShortLabels = [
      'Origin Clinic',
      'Coordinator',
      'Eval Hub',
      'EI Therapy',
    ];

    const careStops: MapStopItem[] = activePathway.steps.map((step, idx) => ({
      id: step.node.provider_id,
      badgeText: String(idx + 1),
      shortRole: roleShortLabels[idx] || `Step ${idx + 1}`,
      name: cleanOrgName(step.node.synthetic_organization_name),
      providerId: step.node.provider_id,
      address: step.node.synthetic_address,
      city: step.node.city,
      countyName: step.node.county_name,
      latitude: step.node.latitude,
      longitude: step.node.longitude,
      distanceFromHomeKm: step.distanceFromHomeKm,
      cumulativeDays: step.cumulativeDays,
      acceptsMedicaid: step.node.accepts_medicaid,
      bilingual: step.node.bilingual_services_listed,
      isSynthetic: true,
    }));

    const stops = [homeStop, ...careStops];

    let focusedStopId = careStops[2]?.id ?? careStops[0].id; // Default focus on Multidisciplinary Eval Hub
    if (preferredFocus === 'origin') focusedStopId = careStops[0].id;
    else if (preferredFocus === 'coordinator') focusedStopId = careStops[1].id;
    else if (preferredFocus === 'eval') focusedStopId = careStops[2].id;
    else if (preferredFocus === 'vendor') focusedStopId = careStops[3].id;
    else if (preferredFocus === 'home') focusedStopId = homeStop.id;
    else if (
      preferredFocus &&
      stops.some((s) => s.id === preferredFocus)
    ) {
      focusedStopId = preferredFocus;
    }

    const lastStop = careStops[careStops.length - 1];
    const waypoints = careStops
      .slice(0, -1)
      .map((s) => ({ lat: s.latitude, lng: s.longitude }));

    const directionsUrl = buildGoogleMapsDirectionsUrl(
      tract.latitude,
      tract.longitude,
      lastStop.latitude,
      lastStop.longitude,
      waypoints,
      travelMode
    );

    return {
      title: `${tract.county_name} CareNode Clinic & Route Map`,
      subtitle: `${activePathway.evalHubDistanceKm} km to bilingual Eval Hub (${careStops[2].city}) · ${activePathway.totalExpectedDays}d total IFSP timeline`,
      stateCode: intake.stateCode,
      travelMode,
      focusedStopId,
      stops,
      directionsUrl,
      transportNote: activePathway.transportAdvisory,
    };
  }

  if (fallbackNode) {
    const distKm = haversineKm(
      tract.latitude,
      tract.longitude,
      fallbackNode.latitude,
      fallbackNode.longitude
    );
    const nodeStop: MapStopItem = {
      id: fallbackNode.provider_id,
      badgeText: '1',
      shortRole: fallbackNode.node_role.replace(/_/g, ' '),
      name: cleanOrgName(fallbackNode.synthetic_organization_name),
      providerId: fallbackNode.provider_id,
      address: fallbackNode.synthetic_address,
      city: fallbackNode.city,
      countyName: fallbackNode.county_name,
      latitude: fallbackNode.latitude,
      longitude: fallbackNode.longitude,
      distanceFromHomeKm: distKm,
      acceptsMedicaid: fallbackNode.accepts_medicaid,
      bilingual: fallbackNode.bilingual_services_listed,
      isSynthetic: true,
    };

    return {
      title: `${nodeStop.name} Location`,
      subtitle: `${distKm} km from ${tract.county_name} (Tract ${tract.census_tract_geoid})`,
      stateCode: intake.stateCode,
      travelMode,
      focusedStopId: nodeStop.id,
      stops: [homeStop, nodeStop],
      directionsUrl: buildGoogleMapsDirectionsUrl(
        tract.latitude,
        tract.longitude,
        nodeStop.latitude,
        nodeStop.longitude,
        [],
        travelMode
      ),
      transportNote: !intake.hasHouseholdVehicle && distKm > 20
        ? `Zero-vehicle household & clinic is ${distKm} km away: authorize Medicaid NEMT or mobile home visit.`
        : null,
    };
  }

  return {
    title: `${tract.county_name} Home Neighborhood Map`,
    subtitle: `Census Tract ${tract.census_tract_geoid}`,
    stateCode: intake.stateCode,
    travelMode,
    focusedStopId: homeStop.id,
    stops: [homeStop],
    directionsUrl: `https://www.google.com/maps/search/?api=1&query=${tract.latitude},${tract.longitude}`,
    transportNote: null,
  };
}
