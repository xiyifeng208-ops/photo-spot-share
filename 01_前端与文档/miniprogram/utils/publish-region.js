const { provinces } = require('../data/cities');

// Only catalogue-backed mainland regions are accepted. Never infer from a title/address.
function normalize(meta = {}) {
  const province = provinces.find(item => item.name === meta.province);
  if (!province) return null;
  const city = province.cities.find(item => item.name === meta[item.field]) ||
    (province.cities.length === 1 && province.cities[0].name === province.name ? province.cities[0] : null);
  if (!city) return null;
  return {
    province: province.name,
    city: city.field === 'city' ? city.name : null,
    district: city.field === 'district' ? city.name : (meta.district || null),
    code: city.code,
    label: province.name === city.name ? city.name : `${province.name} · ${city.name}`
  };
}

function fromIndices(indices) {
  const province = provinces[indices[0]];
  const city = province && province.cities[indices[1]];
  return city ? normalize({ province: province.name, [city.field]: city.name }) : null;
}

function indicesFor(meta) {
  const region = normalize(meta);
  if (!region) return [0, 0];
  const provinceIndex = provinces.findIndex(item => item.name === region.province);
  return [provinceIndex, provinces[provinceIndex].cities.findIndex(item => item.code === region.code)];
}

module.exports = { normalize, fromIndices, indicesFor, provinces };
