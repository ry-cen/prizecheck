"""Generate metadata, card attribute and Reprint Group review types from the API contract."""
import client_generator as gen

TARGET = "web/src/metadata_generated.ts"
NAMES = ('MetadataReportInput','MetadataReportView','MetadataReportUpdate','MetadataReportDecision','MetadataQueueItem','MetadataQueuePage',
             'MetadataDecisionRow','MetadataDecisionInput','MetadataDecisionResult','RuleVersionView','ActiveRuleView','MetadataRuleView',
             'MetadataRuleActivation','MetadataRuleResult','AttributeValues','AttributeReportInput','AttributeReportView',
             'AttributeReportUpdate','AttributeReportDecision','AttributeEvidence','AttributeQueuePage','AttributeDecisionRow',
             'AttributeDecisionInput','AttributeDecisionResult','ReprintGroupPrinting','GroupLegality','ReprintGroupView',
             'CardIdentityEvidence','CardIdentityQueueItem','CardIdentityQueuePage','CardIdentityDecisionRow',
             'ReprintGroupDecisionInput','ReprintGroupDecisionResult','CardIdentityMergeInput','CardIdentityMergeResult')
# Array elements are always parenthesized here, as the generated file has them.
STYLE = gen.TypeStyle(quote='"', parenthesize_arrays="always")

# Refusals share the Holdings error (imported, not redefined); the review routes' error key also counts as a code.
BODY = '''
type Method='GET'|'POST'|'PATCH';
async function request<T>(method: Method,path: string,body?: object): Promise<T> {
  const response=await fetch(path,{method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  if(!response.ok){const result=await response.json().catch(()=>({}));throw new HoldingError(response.status,result?.detail?.code??result?.error??'METADATA_REVIEW_UNAVAILABLE');}
  return response.json() as Promise<T>;
}
const id=(value: string)=>encodeURIComponent(value);
export type MetadataTargetKind='editions'|'printings';
export const submitMetadataReport=(body: MetadataReportInput)=>request<MetadataReportView>('POST','/api/catalog/metadata-reports',body);
export const getMyMetadataReports=()=>request<MetadataReportView[]>('GET','/api/catalog/metadata-reports');
export const getMyMetadataReport=(reportId: string)=>request<MetadataReportView>('GET',`/api/catalog/metadata-reports/${id(reportId)}`);
export const answerMetadataReport=(reportId: string,body: MetadataReportUpdate)=>request<MetadataReportView>('PATCH',`/api/catalog/metadata-reports/${id(reportId)}`,body);
export const getMetadataQueue=(cursor?: string)=>request<MetadataQueuePage>('GET',`/api/admin/catalog-metadata/queue${cursor?`?cursor=${id(cursor)}`:''}`);
export const getMetadataTarget=(kind: MetadataTargetKind,targetId: string)=>request<MetadataQueueItem>('GET',`/api/admin/catalog-metadata/${kind}/${id(targetId)}`);
export const getMetadataHistory=(kind: MetadataTargetKind,targetId: string)=>request<MetadataDecisionRow[]>('GET',`/api/admin/catalog-metadata/${kind}/${id(targetId)}/history`);
export const decideMetadata=(body: MetadataDecisionInput)=>request<MetadataDecisionResult>('POST','/api/admin/catalog-metadata/decisions',body);
export const decideMetadataReport=(reportId: string,body: MetadataReportDecision)=>request<MetadataReportView>('POST',`/api/admin/catalog-metadata/reports/${id(reportId)}/decision`,body);
export const getMetadataRules=()=>request<MetadataRuleView[]>('GET','/api/admin/catalog-rules');
export const activateMetadataRule=(kind: MetadataRuleView['kind'],body: MetadataRuleActivation)=>request<MetadataRuleResult>('POST',`/api/admin/catalog-rules/${kind}/activate`,body);
export const submitAttributeReport=(body: AttributeReportInput)=>request<AttributeReportView>('POST','/api/catalog/attribute-reports',body);
export const getMyAttributeReports=()=>request<AttributeReportView[]>('GET','/api/catalog/attribute-reports');
export const getMyAttributeReport=(reportId: string)=>request<AttributeReportView>('GET',`/api/catalog/attribute-reports/${id(reportId)}`);
export const answerAttributeReport=(reportId: string,body: AttributeReportUpdate)=>request<AttributeReportView>('PATCH',`/api/catalog/attribute-reports/${id(reportId)}`,body);
export const getAttributeQueue=(cursor?: string)=>request<AttributeQueuePage>('GET',`/api/admin/card-attributes/queue${cursor?`?cursor=${id(cursor)}`:''}`);
export const getAttributeEvidence=(printingId: string)=>request<AttributeEvidence>('GET',`/api/admin/card-attributes/${id(printingId)}`);
export const getAttributeHistory=(printingId: string)=>request<AttributeDecisionRow[]>('GET',`/api/admin/card-attributes/${id(printingId)}/history`);
export const decideAttributeReport=(reportId: string,body: AttributeReportDecision)=>request<AttributeReportView>('POST',`/api/admin/card-attributes/reports/${id(reportId)}/decision`,body);
export const decideAttributes=(body: AttributeDecisionInput)=>request<AttributeDecisionResult>('POST','/api/admin/card-attributes/decisions',body);
export const getCardIdentityQueue=(cursor?: string)=>request<CardIdentityQueuePage>('GET',`/api/admin/card-identities/queue${cursor?`?cursor=${id(cursor)}`:''}`);
export const getCardIdentityOfPrinting=(printingId: string)=>request<CardIdentityEvidence>('GET',`/api/admin/card-identities?printing_id=${id(printingId)}`);
export const getCardIdentityEvidence=(identityId: string)=>request<CardIdentityEvidence>('GET',`/api/admin/card-identities/${id(identityId)}`);
export const getCardIdentityHistory=(identityId: string)=>request<CardIdentityDecisionRow[]>('GET',`/api/admin/card-identities/${id(identityId)}/history`);
export const decideReprintGroups=(body: ReprintGroupDecisionInput)=>request<ReprintGroupDecisionResult>('POST','/api/admin/reprint-groups/decisions',body);
export const mergeCardIdentities=(body: CardIdentityMergeInput)=>request<CardIdentityMergeResult>('POST','/api/admin/card-identities/decisions',body);
'''


def render(openapi):
    schemas = openapi["components"]["schemas"]
    return gen.assemble([gen.header("generate_metadata_client", source=False),
                         "import { HoldingError } from './holdings_generated';",
                         *STYLE.aliases(schemas, NAMES), BODY], trailing="\n")


if __name__ == "__main__":
    gen.main(__name__)
