"""Generate Collection read response types from FastAPI OpenAPI."""
import client_generator as gen

TARGET = "web/src/collection_generated.ts"
NAMES = ('CollectionEntry', 'CollectionPage', 'Distribution', 'CollectionTotals', 'CollectionHoldingView',
         'CollectionHoldingPage', 'CollectionSet', 'CollectionSetList', 'CollectionRevision')

# Reads share the Holdings error (imported, not redefined): a refused read carries the same status and code.
BODY = '''
export type CollectionFilters = { name?: string; set_id?: string; collector_number?: string; sort?: 'name' | 'quantity'; location_id?: string };
async function read<T>(path: string): Promise<T> {
  const response=await fetch(path,{credentials:'same-origin'});
  if (!response.ok) { const body=await response.json().catch(()=>({})); throw new HoldingError(response.status,body?.detail?.code ?? 'COLLECTION_UNAVAILABLE'); }
  return response.json() as Promise<T>;
}
export const getCollection = (filters: CollectionFilters={},cursor?: string) => {
  const query=new URLSearchParams(Object.entries({...filters,...(cursor ? {cursor} : {})}).filter(([,value])=>value !== undefined).map(([key,value])=>[key,value as string]));
  return read<CollectionPage>(`/api/collection?${query}`);
};
export const getEditionDistribution = (editionId: string) => read<Distribution>(`/api/collection/editions/${encodeURIComponent(editionId)}`);
export type CardCategory = 'Pokemon' | 'Trainer' | 'Energy';
export type TrainerType = 'supporter' | 'item' | 'tool' | 'stadium';
export type ElementalType = 'Colorless' | 'Darkness' | 'Dragon' | 'Fairy' | 'Fighting' | 'Fire' | 'Grass' | 'Lightning' | 'Metal' | 'Psychic' | 'Water';
export type HoldingSort = 'name-asc' | 'name-desc' | 'set-asc' | 'set-desc' | 'quantity-asc' | 'quantity-desc';
export type CollectionHoldingQuery = { location_id?: string; sort?: HoldingSort; name?: string; set_id?: string; category?: CardCategory; trainer_type?: TrainerType; elemental_type?: ElementalType };
export const getCollectionHoldings = (query: CollectionHoldingQuery={},cursor?: string) => {
  const params=new URLSearchParams(Object.entries({...query,...(cursor ? {cursor} : {})}).filter(([,value])=>value !== undefined).map(([key,value])=>[key,value as string]));
  return read<CollectionHoldingPage>(`/api/collection/holdings?${params}`);
};
export const getCollectionSets = (locationId?: string) => read<CollectionSetList>(`/api/collection/sets${locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''}`);
export const getCollectionRevision = () => read<CollectionRevision>('/api/collection/revision');
'''


def render(openapi):
    schemas = openapi["components"]["schemas"]
    return gen.assemble([gen.header("generate_collection_client", source=False),
                         "import { HoldingError, type HoldingView } from './holdings_generated';",
                         *gen.SINGLE.aliases(schemas, NAMES), BODY], trailing="\n")


if __name__ == "__main__":
    gen.main(__name__)
