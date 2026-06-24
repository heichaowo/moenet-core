import {
	DataTypes,
	type Model,
	type ModelStatic,
	type Sequelize,
} from "sequelize";

export interface SettingAttributes {
	key: string;
	value: string;
}

export type SettingsModel = ModelStatic<Model<SettingAttributes>>;

export function initSettingsModel(sequelize: Sequelize): SettingsModel {
	return sequelize.define(
		"settings",
		{
			key: {
				type: DataTypes.STRING,
				primaryKey: true,
			},
			value: {
				type: DataTypes.TEXT,
				allowNull: false,
			},
		},
		{
			timestamps: false,
		},
	);
}
