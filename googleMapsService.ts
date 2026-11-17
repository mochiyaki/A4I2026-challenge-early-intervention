import { cleanOrgName, getStateData, haversineKm } from '../engine/graphTriageEngine';
import type {
  CandidatePathway,
  CareNode,
  ClinicMapPayload,
  MapStopItem,
  ReferralIntakeInput,
  StateCode,
  StatePartCHelplineInfo,
  TractDemographic,
  TransmissionChannel,
} from '../types';

const MAPS_KEY_STORAGE = 'a4i_google_maps_api_key';

export interface GoogleMapsLatLngLiteral {
  lat: number;
  lng: number;
}

export interface GooglePlaceContactResult {
  placeName?: string;
  formattedPhone?: string;
  website?: string;
  openNowLabel?: string;
}

/* Minimal ambient Google Maps JS SDK + Places API surface */
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
    places?: {
      PlacesService: new (attrContainer: HTMLElement | unknown) => {
        findPlaceFromQuery: (
          request: {
            query: string;
            fields: string[];
            locationBias?: GoogleMapsLatLngLiteral;
          },
          callback: (
            results: { place_id?: string; name?: string }[] | null,
            status: string
          ) => void
        ) => void;
        getDetails: (
          request: { placeId: string; fields: string[] },
          callback: (
            place: {
              name?: string;
              formatted_phone_number?: string;
              website?: string;
              opening_hours?: { isOpen?: () => boolean };
            } | null,
            status: string
          ) => void
        ) => void;
      };
      PlacesServiceStatus: {
        OK: string;
      };
    };
  };
}

declare global {
  interface Window {
    google?: GoogleMapsRuntime;
    gm_authFailure?: () => void;
  }
}

/**
 * Official Public Statewide IDEA Part C Lead Agency Referral Helplines & Portals
 */
const STATE_PART_C_HELPLINES: Record<
  StateCode,
  Omit<StatePartCHelplineInfo, 'regionalSyntheticOffice'>
> = {
  MS: {
    programName: 'Mississippi First Steps Early Intervention (MSDH)',
    tollFreePhone: '1-800-451-3903',
    officialUrl: 'https://msdh.ms.gov/page/41,0,74.html',
  },
  AL: {
    programName: 'Alabama Early Intervention System (AEIS)',
    tollFreePhone: '1-800-543-3098',
    officialUrl: 'https://rehab.alabama.gov/services/ei',
  },
  GA: {
    programName: "Georgia Babies Can't Wait (DPH Part C)",
    tollFreePhone: '1-888-651-8224',
    officialUrl: 'https://dph.georgia.gov/babies-cant-wait',
  },
  TX: {
    programName: 'Texas Early Childhood Intervention (HHS ECI)',
    tollFreePhone: '1-877-787-8999',
    officialUrl: 'https://www.hhs.texas.gov/services/disability/early-childhood-intervention-services',
  },
  CA: {
    programName: 'California Early Start Program (DDS)',
    tollFreePhone: '1-800-515-2229',
    officialUrl: 'https://www.dds.ca.gov/services/early-start/',
  },
  NY: {
    programName: 'New York State Early Intervention Program (NYSDOH)',
    tollFreePhone: '1-800-522-5006',
    officialUrl: 'https://www.health.ny.gov/community/infants_children/early_intervention/',
  },
};

const STATE_AREA_CODES: Record<StateCode, string> = {
  MS: '662',
  AL: '334',
  GA: '229',
  TX: '956',
  CA: '209',
  NY: '718',
};

/**
 * Generates deterministic FCC-reserved 555-01xx synthetic demo contact details
 * for each 100% [Synthetic] CareNode (`SYN-PROV-*`) so coordinators can copy/view
 * phone, e-Portal intake address, and hours directly under the map without confusion.
 */
function buildSyntheticNodeContact(
  node: CareNode,
  channelIn?: TransmissionChannel
): Pick<
  MapStopItem,
  | 'syntheticPhone'
  | 'intakeEmail'
  | 'intakeChannelLabel'
  | 'hoursText'
  | 'specialty'
  | 'partCVendorEnrolled'
  | 'medianInternalWaitDays'
  | 'monthlySlotCapacity'
> {
  const numMatch = node.provider_id.match(/(\d+)$/);
  const seq = numMatch ? Number(numMatch[1]) % 100 : 10;
  const area = STATE_AREA_CODES[node.state_code] || '800';
  const lastTwo = String(seq).padStart(2, '0');

  // NANP 555-0100..555-0199 is officially reserved for synthetic/fictional telephone numbers
  const syntheticPhone = `(${area}) 555-01${lastTwo}`;
  const slug = node.provider_id.toLowerCase().replace(/^syn-prov-/, '').replace(/[^a-z0-9]/g, '');
  const intakeEmail = `intake.${slug}@syn-partc-referral.example`;

  let intakeChannelLabel = 'Electronic e-Portal & Direct Phone';
  if (channelIn === 'ehr_electronic_portal') {
    intakeChannelLabel = 'Direct EHR e-Portal (Fast-Track)';
  } else if (channelIn === 'paper_fax') {
    intakeChannelLabel = 'Legacy Paper Fax / Phone Intake';
  } else if (channelIn === 'phone_voicemail') {
    intakeChannelLabel = 'Coordinator Phone / Voicemail Triage';
  }

  const hoursText = node.bilingual_services_listed
    ? 'Mon–Fri · 8:00 AM – 5:00 PM (Spanish/English bilingual coordinator)'
    : 'Mon–Fri · 8:30 AM – 4:30 PM (Interpreter line available)';

  return {
    syntheticPhone,
    intakeEmail,
    intakeChannelLabel,
    hoursText,
    specialty: node.specialty_description,
    partCVendorEnrolled: node.part_c_vendor_enrolled,
    medianInternalWaitDays: node.median_internal_wait_days,
    monthlySlotCapacity: node.monthly_slot_capacity,
  };
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
 * Dynamically loads the official Google Maps JavaScript API (with `libraries=places`
 * for live Places contact enrichment when available), handling `gm_authFailure` cleanly.
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

  const existingScript = document.getElementById('pm-google-maps-sdk');
  if (existingScript && loadedWithKey !== cleanKey) {
    existingScript.remove();
    activeLoaderPromise = null;
  }

  loadedWithKey = cleanKey;
  activeLoaderPromise = new Promise<GoogleMapsRuntime>((resolve, reject) => {
    window.gm_authFailure = () => {
      activeLoaderPromise = null;
      reject(
        new Error(
          'Google Maps API key authentication failed (check key restrictions or billing).'
        )
      );
    };

    const script = document.createElement('script');
    script.id = 'pm-google-maps-sdk';
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cleanKey)}&libraries=places&v=weekly`;
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
 * Queries Google Maps Places API (`PlacesService`) when the JS SDK + Places library is active
 * to enrich real regional Part C / pediatric center contact info if found near the pin.
 */
export function lookupGooglePlacesContact(
  g: GoogleMapsRuntime,
  mapOrContainer: unknown,
  query: string,
  bias: GoogleMapsLatLngLiteral
): Promise<GooglePlaceContactResult | null> {
  return new Promise((resolve) => {
    const placesNs = g.maps.places;
    if (!placesNs) {
      resolve(null);
      return;
    }
    try {
      const service = new placesNs.PlacesService(mapOrContainer);
      service.findPlaceFromQuery(
        {
          query,
          fields: ['place_id', 'name'],
          locationBias: bias,
        },
        (results, status) => {
          if (
            status !== placesNs.PlacesServiceStatus.OK ||
            !results ||
            !results[0]?.place_id
          ) {
            resolve(null);
            return;
          }
          service.getDetails(
            {
              placeId: results[0].place_id,
              fields: ['name', 'formatted_phone_number', 'website', 'opening_hours'],
            },
            (place, detailStatus) => {
              if (detailStatus !== placesNs.PlacesServiceStatus.OK || !place) {
                resolve(null);
                return;
              }
              const isOpenNow = place.opening_hours?.isOpen?.();
              resolve({
                placeName: place.name,
                formattedPhone: place.formatted_phone_number,
                website: place.website,
                openNowLabel:
                  typeof isOpenNow === 'boolean'
                    ? isOpenNow
                      ? 'Open now (Google Places)'
                      : 'Closed now (Google Places)'
                    : undefined,
              });
            }
          );
        }
      );
    } catch {
      resolve(null);
    }
  });
}

export function buildGoogleMapsEmbedUrl(
  latitude: number,
  longitude: number,
  zoom = 13
): string {
  const lat = latitude.toFixed(5);
  const lng = longitude.toFixed(5);
  return `https://maps.google.com/maps?q=${lat},${lng}&ll=${lat},${lng}&z=${zoom}&output=embed`;
}

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

  const stateAgencies = getStateData(intake.stateCode).agencies;
  const leadAgency = stateAgencies[0];
  const baseHelpline = STATE_PART_C_HELPLINES[intake.stateCode];
  const statePartCHotline: StatePartCHelplineInfo = {
    ...baseHelpline,
    regionalSyntheticOffice: leadAgency
      ? `${cleanOrgName(leadAgency.synthetic_agency_name)} (${leadAgency.agency_id} · ${leadAgency.synthetic_office_address})`
      : undefined,
  };

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
    hoursText: 'Family Residence Neighborhood Centroid (US Census ACS)',
    intakeChannelLabel: !intake.hasHouseholdVehicle
      ? 'Zero-vehicle household — request Medicaid NEMT pickup or mobile home visit'
      : 'Household vehicle available',
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
      ...buildSyntheticNodeContact(step.node, step.channelIn),
      isSynthetic: true,
    }));

    const stops = [homeStop, ...careStops];

    let focusedStopId = careStops[2]?.id ?? careStops[0].id;
    if (preferredFocus === 'origin') focusedStopId = careStops[0].id;
    else if (preferredFocus === 'coordinator') focusedStopId = careStops[1].id;
    else if (preferredFocus === 'eval') focusedStopId = careStops[2].id;
    else if (preferredFocus === 'vendor') focusedStopId = careStops[3].id;
    else if (preferredFocus === 'home') focusedStopId = homeStop.id;
    else if (preferredFocus && stops.some((s) => s.id === preferredFocus)) {
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
      statePartCHotline,
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
      ...buildSyntheticNodeContact(fallbackNode),
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
      transportNote:
        !intake.hasHouseholdVehicle && distKm > 20
          ? `Zero-vehicle household & clinic is ${distKm} km away: authorize Medicaid NEMT or mobile home visit.`
          : null,
      statePartCHotline,
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
    statePartCHotline,
  };
}
