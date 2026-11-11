import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Frozen from baseline d6a0b4b614daa1c321c735a2ca09aab27d78e193;
// Drive 0040 from accepted d5f4896; sources 0041 from accepted 9004c35; connection 0042 from accepted f1185a8.
const baseline = [
 {
  "name": "0001_initial.sql",
  "sha256": "0cb16e9adb7fccf75eb08ed84533da7ce37e3ecb1c9a1ca8858d97f9af37c005"
 },
 {
  "name": "0002_supervised_attempts.sql",
  "sha256": "6fcb098b376352c50622a3024a8f1a93d5e7841da2c862e2a608b678cc3a504d"
 },
 {
  "name": "0003_supervised_cancel.sql",
  "sha256": "178b90c411a8b905d235906b24e0091e937a79a30c16dfdc6b2a06d864941951"
 },
 {
  "name": "0004_attempt_fence.sql",
  "sha256": "1819f28a8f3d4f05a267e2eebdedec3a4c3bfe0fa2d75c0d6e2467b519ec7c52"
 },
 {
  "name": "0005_attempt_outcome_detail.sql",
  "sha256": "7a7014f60208acc5ad272ff773e88ba82b5ddc1b6176ac139b651e933f410541"
 },
 {
  "name": "0006_work_outcome_closed.sql",
  "sha256": "46b789f1ad074968b0a8646d9e5bf89e6599f009e6d844324895676464212239"
 },
 {
  "name": "0007_work_dependencies.sql",
  "sha256": "b16f4ecf642f106bcc1833e1954692450139351545782027d1c3af118d9ca22b"
 },
 {
  "name": "0008_work_serialization_key.sql",
  "sha256": "c743016c1b05d5285e760115f4f2327908dd6cca15216c0af91a029e836b48bf"
 },
 {
  "name": "0009_local_schedules.sql",
  "sha256": "c89e3a454b58ae9845bf5dcc792f1907afca294e2d07b1b9a127a16bf19ce051"
 },
 {
  "name": "0010_work_hold_groups.sql",
  "sha256": "97f62c1bc98537e911de2d2d415e486947a4349d8d63c19168c325099bbb7122"
 },
 {
  "name": "0011_extension_registry.sql",
  "sha256": "4caed7c2280d1624ef599a24fc3b78696298cd9fb7b1560f3da3094173a550b1"
 },
 {
  "name": "0012_extension_work_kinds.sql",
  "sha256": "5d7dd51cfc58b00d9b1b390f9527ceabbed582254ee6fa1d56429750f9e0c718"
 },
 {
  "name": "0013_extension_python_environment.sql",
  "sha256": "4e9656c2271f9804924948b4411834686a9eb340d14c448559e3f435a13d55cb"
 },
 {
  "name": "0014_conversation_chunks.sql",
  "sha256": "62e1781e6090b5261827e4c0894afd7c1cf3130674c5776aef74db08806ab92d"
 },
 {
  "name": "0015_extension_status_public.sql",
  "sha256": "f0064e1bfe4a9f641b9823829c4dd7c9af0d05d73d6ffc6bf691d7b06bf1bc46"
 },
 {
  "name": "0016_extension_install_progress.sql",
  "sha256": "aeb2eaca9f71d044204e8ac0aa1eeb976e634fab635075dcdc2ffa24554206eb"
 },
 {
  "name": "0017_channels.sql",
  "sha256": "fbae2432efc9ed5cd1b867832a56b653648a85b3604c4fc6b0291a83183d775e"
 },
 {
  "name": "0018_channel_attempt_results.sql",
  "sha256": "439ef797178197d71109fdd78ee0771593b00cd7029fc7108a3a9c83ccb39a9b"
 },
 {
  "name": "0019_channel_legacy.sql",
  "sha256": "6b350c210ae2f048b89329fb7440e7d606b0e954e2cdd7cb2110280b88b77683"
 },
 {
  "name": "0020_channel_bundle.sql",
  "sha256": "1083a511f0aba9e22745671b3d9703df4b672fd0f443e80f075df98464fd47b8"
 },
 {
  "name": "0021_channel_attempt_order.sql",
  "sha256": "4476935cc1aaea42b9573ec98bcc0be0f4b987a5887c88ac2f3c135d76d6cb8f"
 },
 {
  "name": "0022_import_contracts.sql",
  "sha256": "c35362513f2c0e22af141b4d5d9f034ef014afb909b57690341df88b9be37316"
 },
 {
  "name": "0023_health_contract.sql",
  "sha256": "51bbb2d811b860d08213d2c4291a61fd258e39462006565bee0983cb76611b7d"
 },
 {
  "name": "0024_health_authority_import.sql",
  "sha256": "497ac4133930dd1dcdf05deb90b443e066008549b25e72ee2ec9422bf25d4e64"
 },
 {
  "name": "0025_original_text.sql",
  "sha256": "22ad4bc2fa6d129257d80e2b2f656b9b6aa0b47d3ff21f9a0a88545323dd9a3d"
 },
 {
  "name": "0026_health_json_comparison.sql",
  "sha256": "60927eb8df34491cec73a803cf7405831c6431223192d071c5d877468c066e4d"
 },
 {
  "name": "0027_analysis_artifacts.sql",
  "sha256": "b16d76a7ee631ebff790aa0e95d348ccf121717d961ecc537f99c792fc131582"
 },
 {
  "name": "0028_file_request_metadata.sql",
  "sha256": "2b8832c48235567bcc426a63f1f68f22e20bbdf2d809c15dd62ffbee95e9ab3f"
 },
 {
  "name": "0029_core_analyses.sql",
  "sha256": "0bf8a8f4a92a15cfef0d7f26667d7154651268b607f6ec02b60382cf490fb17b"
 },
 {
  "name": "0030_analysis_snapshot_inputs.sql",
  "sha256": "e7498db29ffa017842e5eb4dfea7e9f2f3ac103951e24a2e64c1f485204e317d"
 },
 {
  "name": "0031_remove_core_garmin.sql",
  "sha256": "6e1097b258af887858d4a5d9b5e05fe96ed901475a7eb6250860495e38f939e0"
 },
 {
  "name": "0032_user_keys.sql",
  "sha256": "980238ff38d1b7893954383f73089f244d855020f78834bf7f737cebc3142312"
 },
 {
  "name": "0033_schedule_occurrences.sql",
  "sha256": "a5d526f6bbaff494efb38e390bcb78363c895b87f76f3d151310ad81b0a98a3e"
 },
 {
  "name": "0034_extension_package_identity.sql",
  "sha256": "3005214c00c644927b68841a80bab31ea392211bfc9ed0f443e71dff6f0e641a"
 },
 {
  "name": "0035_extension_quiesce.sql",
  "sha256": "93cb23d71bfb4e7bd903901a030856e6662d525a8cbecbae17f92d3c2cedef7c"
 },
 {
  "name": "0036_schedule_target_setting.sql",
  "sha256": "a19eb20f6029b3e782facac1bbe6338c37d86f97cc1147f3eeb67794ae70564f"
 },
 {
  "name": "0037_schedule_dependency.sql",
  "sha256": "9bbed47a9aefe4e4c9c78a8fe8915a03ab1f6bfd6ffac690a0b5b1cc213ab1e8"
 },
 {
  "name": "0038_extension_channel_publish.sql",
  "sha256": "77b5cf7e1b0d9a832470593be81b7ad0651a1cbde25f8a38e632ab3d8f590f4d"
 },
 {
  "name": "0039_import_cleanup_indexes.sql",
  "sha256": "eb2c86609b7638d4d0676f6d696f97318d2a0c50959e4f2144264b664ffa9d3d"
 }
];
const drive = {"name": "0040_drive_uploads.sql", "sha256": "597fef789bea7a96aadc2640826420960e097fcb7cf011b74ae898db481e7e17"};
const sources = {"name": "0041_sources.sql", "sha256": "ddbd4a0e1c1824a3dd8a5f2d307934e6f687d594b0a347185f1bc799636ffa11"};
const connection = {"name": "0042_drive_connection.sql", "sha256": "1ed2dca551de313f02e636568186d245618a48880300147f42ad5da9a2ffb57d"};
const documentCarry = {"name": "0043_document_carry.sql", "sha256": "c0eb6f1c8339ae4bbdebdf689e7bbcf24b4ac12c0c2395f3992203ff5e69a410"};
const driveResume = {"name": "0044_drive_resume.sql", "sha256": "ba31747c34b80f435ed1a3781bb54866200196e0c64f161039e6098f430dae3c"};
const channelTopics = {"name": "0045_channel_topics.sql", "sha256": "f0dcc6927669dae995beb35fcb5777133e6834f40987e9909f3c89396ad9f2e8"};
const workInputs = {"name": "0046_extension_work_inputs.sql", "sha256": "dc67f677b7b2f36bb8096376d852c359d7abd54b03cadf2bdd2fc40119acb510"};
export function expectedSchema(version) {
 if(version!==39 && version!==40 && version!==41 && version!==42 && version!==43 && version!==44 && version!==45 && version!==46) throw Error('unexpected checkout schema');
 return {version, apiVersion:version, manifest: structuredClone(version===39 ? baseline : version===40 ? [...baseline,drive] : version===41 ? [...baseline,drive,sources] : version===42 ? [...baseline,drive,sources,connection] : version===43 ? [...baseline,drive,sources,connection,documentCarry] : version===44 ? [...baseline,drive,sources,connection,documentCarry,driveResume] : version===45 ? [...baseline,drive,sources,connection,documentCarry,driveResume,channelTopics] : [...baseline,drive,sources,connection,documentCarry,driveResume,channelTopics,workInputs])};
}
export function inspectMigrationDirectory(directory, apiVersion) {
 const expected=expectedSchema(apiVersion);
 const names=readdirSync(directory,{withFileTypes:true}).filter(e=>e.name.endsWith('.sql')).map(e=>{
  if(!e.isFile()) throw Error('invalid migration entry');
  return e.name;
 }).sort();
 const manifest=names.map(name=>({name,sha256:createHash('sha256').update(readFileSync(resolve(directory,name))).digest('hex')}));
 if(JSON.stringify(manifest)!==JSON.stringify(expected.manifest)) throw Error('unexpected migration manifest');
 return {version:expected.version,apiVersion,manifest};
}
export function schemaEvidenceValid(evidence, version, to) {
 return to===version && JSON.stringify(evidence)===JSON.stringify(expectedSchema(version));
}
