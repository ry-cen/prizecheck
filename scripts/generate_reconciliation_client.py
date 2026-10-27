"""Generate catalog decision and reassignment types from the API contract."""
import client_generator as gen

TARGET = "web/src/reconciliation_generated.ts"
NAMES = ('CatalogReviewView', 'ReviewEditionView', 'EditionReplacementInput', 'CatalogDecision', 'ReassignHolding',
         'ReassignResult', 'ReplacementView')

# Refusals share the Holdings error (imported, not redefined).
BODY = '''
async function request<T>(path: string,body?: object): Promise<T> {
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  if(!response.ok){const result=await response.json().catch(()=>({}));throw new HoldingError(response.status,result?.detail?.code??'CATALOG_REVIEW_UNAVAILABLE');}
  return response.json() as Promise<T>;
}
export const getCatalogReviews=()=>request<CatalogReviewView[]>('/api/admin/catalog-reviews');
export const getReviewEditions=(id: string)=>request<ReviewEditionView[]>(`/api/admin/catalog-reviews/${encodeURIComponent(id)}/editions`);
export const decideCatalogReview=(id: string,body: CatalogDecision)=>request<CatalogReviewView>(`/api/admin/catalog-reviews/${encodeURIComponent(id)}/decision`,body);
export const getEditionReplacements=()=>request<ReplacementView[]>('/api/catalog/edition-replacements');
export const reassignHolding=(body: ReassignHolding)=>request<ReassignResult>('/api/holdings/reassign',body);
'''


def render(openapi):
    schemas = openapi["components"]["schemas"]
    return gen.assemble([gen.header("generate_reconciliation_client", source=False),
                         "import { HoldingError } from './holdings_generated';",
                         *gen.DOUBLE.aliases(schemas, NAMES), BODY], trailing="\n")


if __name__ == "__main__":
    gen.main(__name__)
