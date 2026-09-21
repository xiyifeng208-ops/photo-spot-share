import catalogue from './mainland-regions.json';
import type { GeoMetaDto } from './dto/spot.dto';

export interface NormalizedGeo {
  province: string;
  city: string | null;
  district: string | null;
  address: string | null;
}

export function cleanGeo(geo?: GeoMetaDto): GeoMetaDto {
  const text = (value: string | null | undefined) => value?.trim() || null;
  return {
    province: text(geo?.province), city: text(geo?.city),
    district: text(geo?.district), address: text(geo?.address),
  };
}

/** Same mainland catalogue as the picker; ordinary districts are retained, not guessed. */
export function normalizeRegion(input?: GeoMetaDto): NormalizedGeo | null {
  const geo = cleanGeo(input);
  let province = catalogue.provinces.find(item => item.name === geo.province);
  if (!geo.province) {
    const candidates = catalogue.provinces.filter(item => item.cities.some(city =>
      (geo.city && city.name === geo.city) || (!geo.city && city.field === 'district' && city.name === geo.district)));
    if (candidates.length === 1) province = candidates[0];
  }
  if (!province) return null;

  const municipality = province.cities.length === 1 && province.cities[0].name === province.name;
  if (municipality) {
    if (geo.city && geo.city !== province.name) return null;
    return { province: province.name, city: province.name, district: geo.district ?? null, address: geo.address ?? null };
  }
  const directDistrict = province.cities.find(item => item.field === 'district' && item.name === geo.district);
  if (directDistrict && geo.city && geo.city !== directDistrict.name
    && !/直辖县级行政|直辖行政单位/.test(geo.city)) return null;
  const lookupName = directDistrict && (!geo.city || /直辖县级行政|直辖行政单位/.test(geo.city))
    ? geo.district : (geo.city || geo.district);
  const region = province.cities.find(item => item.name === lookupName);
  if (!region) return null;
  if (region.field === 'district') {
    if (geo.district && geo.district !== region.name) return null;
    return { province: province.name, city: null, district: region.name, address: geo.address ?? null };
  }
  return { province: province.name, city: region.name, district: geo.district ?? null, address: geo.address ?? null };
}

/** Fill absent values only when the supplied and reverse-geocoded region do not conflict. */
export function supplementGeo(provided: GeoMetaDto, reverse: GeoMetaDto): GeoMetaDto {
  const manual = cleanGeo(provided);
  const resolved = cleanGeo(reverse);
  if ((manual.province && resolved.province && manual.province !== resolved.province)
    || (manual.city && resolved.city && manual.city !== resolved.city)
    || (manual.district && resolved.district && manual.district !== resolved.district)) return manual;
  return {
    province: manual.province || resolved.province,
    city: manual.city || resolved.city,
    district: manual.district || resolved.district,
    address: manual.address || resolved.address,
  };
}
